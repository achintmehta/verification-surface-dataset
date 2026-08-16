import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';

export const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 60_000);

/**
 * Release all holds (and their seats) whose expires_at has passed and that are
 * still 'active'. Runs inside the provided transaction object (tx) so it can be
 * composed atomically with hold/confirm operations.
 *
 * Returns the list of seat ids that were released so the caller can broadcast.
 */
export async function expireStaleHolds(tx) {
  // Mark expired holds.
  await tx.query(
    `UPDATE holds
        SET status = 'expired'
      WHERE status = 'active'
        AND expires_at <= now()`
  );

  // Release seats whose hold is no longer active or whose hold has expired.
  const released = await tx.query(
    `UPDATE seats
        SET status = 'available',
            hold_id = NULL,
            hold_expires_at = NULL
      WHERE status = 'held'
        AND (hold_expires_at IS NULL OR hold_expires_at <= now())
      RETURNING id`
  );
  return released.rows.map((r) => r.id);
}

/**
 * Return every seat with its *effective* status. Lazily expires stale holds
 * first so a held-but-expired seat is reported as available.
 *
 * Returns { seats, released } where released is the list of seat ids freed by
 * the lazy expiry sweep (for broadcasting).
 */
export async function getSeats() {
  const db = getDb();
  let released = [];
  await db.transaction(async (tx) => {
    released = await expireStaleHolds(tx);
  });
  const res = await db.query(
    `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
       FROM seats
      ORDER BY row_label, seat_number`
  );
  return { seats: res.rows.map(serializeSeat), released };
}

function serializeSeat(row) {
  return {
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: row.seat_number,
    status: row.status,
    holdId: row.hold_id,
    holdExpiresAt: row.hold_expires_at
      ? new Date(row.hold_expires_at).toISOString()
      : null,
    bookedBy: row.booked_by,
  };
}

/**
 * Atomically acquire ALL requested seats for a session, all-or-nothing.
 *
 * On success returns { ok: true, hold, seatIds, released }.
 * On conflict returns { ok: false, conflicts: [...seatIds], released }.
 */
export async function createHold(seatIds, sessionId) {
  const db = getDb();
  const holdId = randomUUID();
  const expiresAt = new Date(Date.now() + HOLD_TTL_MS);

  // Deduplicate and validate input.
  const uniqueIds = [...new Set(seatIds)];

  let result;
  await db.transaction(async (tx) => {
    // 1) Expire stale holds first so freed seats become acquirable.
    const released = await expireStaleHolds(tx);

    // 2) Lock the requested seats deterministically (ordered) to avoid
    //    deadlocks, and read their current effective status.
    const sel = await tx.query(
      `SELECT id, status, hold_expires_at
         FROM seats
        WHERE id = ANY($1::text[])
        ORDER BY id
        FOR UPDATE`,
      [uniqueIds]
    );

    const found = new Map(sel.rows.map((r) => [r.id, r]));

    // Any requested id that doesn't exist is a conflict.
    const conflicts = [];
    for (const id of uniqueIds) {
      const row = found.get(id);
      if (!row) {
        conflicts.push(id);
        continue;
      }
      const expired =
        row.hold_expires_at && new Date(row.hold_expires_at) <= new Date();
      const effective = row.status === 'held' && expired ? 'available' : row.status;
      if (effective !== 'available') {
        conflicts.push(id);
      }
    }

    if (conflicts.length > 0) {
      result = { ok: false, conflicts, released };
      return; // transaction commits the expiry releases, acquires nothing
    }

    // 3) Create the hold record.
    await tx.query(
      `INSERT INTO holds (id, session_id, status, expires_at)
       VALUES ($1, $2, 'active', $3)`,
      [holdId, sessionId, expiresAt.toISOString()]
    );

    // 4) Mark all seats held in one conditional update. Guard each seat is
    //    still available to be fully race-safe even within the lock window.
    const upd = await tx.query(
      `UPDATE seats
          SET status = 'held',
              hold_id = $1,
              hold_expires_at = $2
        WHERE id = ANY($3::text[])
          AND status = 'available'
        RETURNING id`,
      [holdId, expiresAt.toISOString(), uniqueIds]
    );

    if (upd.rows.length !== uniqueIds.length) {
      // Lost a race for at least one seat: abort the whole hold.
      throw new HoldConflict(uniqueIds);
    }

    result = {
      ok: true,
      released,
      hold: {
        id: holdId,
        sessionId,
        status: 'active',
        expiresAt: expiresAt.toISOString(),
        seatIds: uniqueIds,
      },
      seatIds: uniqueIds,
    };
  }).catch((err) => {
    if (err instanceof HoldConflict) {
      result = { ok: false, conflicts: err.seatIds, released: [] };
    } else {
      throw err;
    }
  });

  return result;
}

class HoldConflict extends Error {
  constructor(seatIds) {
    super('hold conflict');
    this.seatIds = seatIds;
  }
}

/**
 * Confirm a hold: book its seats permanently. Idempotent. Re-validates
 * existence, ownership, and expiry inside the transaction.
 *
 * Returns one of:
 *   { ok: true, booking, seatIds, alreadyConfirmed }
 *   { ok: false, error: 'not_found' | 'expired' }
 */
export async function confirmHold(holdId) {
  const db = getDb();
  let result;

  await db.transaction(async (tx) => {
    // Expire stale holds first (this may flip our hold to 'expired').
    await expireStaleHolds(tx);

    // Lock the hold row.
    const holdRes = await tx.query(
      `SELECT id, session_id, status, expires_at
         FROM holds
        WHERE id = $1
        FOR UPDATE`,
      [holdId]
    );

    if (holdRes.rows.length === 0) {
      result = { ok: false, error: 'not_found' };
      return;
    }

    const hold = holdRes.rows[0];

    // Idempotency: already confirmed -> return the same booking, book nothing.
    if (hold.status === 'confirmed') {
      const seats = await tx.query(
        `SELECT id FROM seats WHERE hold_id = $1 AND status = 'booked' ORDER BY id`,
        [holdId]
      );
      result = {
        ok: true,
        alreadyConfirmed: true,
        booking: {
          holdId,
          sessionId: hold.session_id,
          seatIds: seats.rows.map((r) => r.id),
        },
        seatIds: [],
      };
      return;
    }

    // Reject expired / released / unknown-status holds; book nothing.
    if (hold.status !== 'active' || new Date(hold.expires_at) <= new Date()) {
      result = { ok: false, error: 'expired' };
      return;
    }

    // Lock and verify the held seats still belong to this hold and are held.
    const seatRes = await tx.query(
      `SELECT id, status, hold_id
         FROM seats
        WHERE hold_id = $1
        ORDER BY id
        FOR UPDATE`,
      [holdId]
    );

    const heldSeats = seatRes.rows.filter(
      (s) => s.status === 'held' && s.hold_id === holdId
    );

    if (heldSeats.length === 0) {
      // No seats actually held by this hold -> treat as expired/invalid.
      result = { ok: false, error: 'expired' };
      return;
    }

    const seatIds = heldSeats.map((s) => s.id);

    // Book them.
    await tx.query(
      `UPDATE seats
          SET status = 'booked',
              booked_by = $1,
              hold_expires_at = NULL
        WHERE hold_id = $2
          AND status = 'held'`,
      [hold.session_id, holdId]
    );

    await tx.query(
      `UPDATE holds
          SET status = 'confirmed', confirmed_at = now()
        WHERE id = $1`,
      [holdId]
    );

    result = {
      ok: true,
      alreadyConfirmed: false,
      booking: { holdId, sessionId: hold.session_id, seatIds },
      seatIds,
    };
  });

  return result;
}

/**
 * Release a hold early, returning its seats to available.
 * Returns { ok: true, seatIds } or { ok: false, error }.
 */
export async function releaseHold(holdId) {
  const db = getDb();
  let result;

  await db.transaction(async (tx) => {
    const holdRes = await tx.query(
      `SELECT id, status FROM holds WHERE id = $1 FOR UPDATE`,
      [holdId]
    );

    if (holdRes.rows.length === 0) {
      result = { ok: false, error: 'not_found' };
      return;
    }

    const hold = holdRes.rows[0];

    if (hold.status === 'confirmed') {
      // Cannot release booked seats.
      result = { ok: false, error: 'already_confirmed' };
      return;
    }

    const freed = await tx.query(
      `UPDATE seats
          SET status = 'available', hold_id = NULL, hold_expires_at = NULL
        WHERE hold_id = $1 AND status = 'held'
        RETURNING id`,
      [holdId]
    );

    await tx.query(
      `UPDATE holds SET status = 'released' WHERE id = $1 AND status = 'active'`,
      [holdId]
    );

    result = { ok: true, seatIds: freed.rows.map((r) => r.id) };
  });

  return result;
}

/** Periodic sweep used outside request handlers. Returns released seat ids. */
export async function sweepExpired() {
  const db = getDb();
  let released = [];
  await db.transaction(async (tx) => {
    released = await expireStaleHolds(tx);
  });
  return released;
}

/** Inventory counts for sanity / debugging. */
export async function getInventory() {
  const db = getDb();
  await sweepExpired();
  const res = await db.query(
    `SELECT status, COUNT(*)::int AS c FROM seats GROUP BY status`
  );
  const counts = { available: 0, held: 0, booked: 0 };
  for (const row of res.rows) counts[row.status] = row.c;
  return counts;
}
