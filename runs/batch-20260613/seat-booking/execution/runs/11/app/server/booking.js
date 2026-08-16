import { randomUUID } from 'node:crypto';
import { getDb, runExclusive, HOLD_TTL_MS, TOTAL_SEATS } from './db.js';
import { broadcast } from './sse.js';

/**
 * Release any holds whose expires_at is in the past. Returns the list of
 * seat ids that were released so callers can broadcast them.
 * MUST be called inside a transaction (db is the transaction handle).
 */
async function expireStaleHolds(tx) {
  // Find currently-held seats whose hold has expired.
  const { rows: expiredSeats } = await tx.query(
    `SELECT id FROM seats
     WHERE status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at <= now()`
  );
  if (expiredSeats.length === 0) return [];

  await tx.query(
    `UPDATE seats
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL
     WHERE status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at <= now()`
  );
  await tx.query(
    `UPDATE holds SET status = 'expired'
     WHERE status = 'active' AND expires_at <= now()`
  );

  return expiredSeats.map((r) => r.id);
}

/**
 * Run an exclusive transaction. Serialized via runExclusive so seat
 * acquisition is atomic check-and-set: no two requests interleave.
 */
async function inTransaction(fn) {
  const db = await getDb();
  return runExclusive(async () => {
    let result;
    let released = [];
    await db.transaction(async (tx) => {
      released = await expireStaleHolds(tx);
      result = await fn(tx);
    });
    // Broadcast expiries that happened during this operation.
    if (released.length) {
      broadcast({
        type: 'released',
        seatIds: released,
        seats: released.map((id) => ({ id, status: 'available' })),
        reason: 'expired',
      });
    }
    return result;
  });
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Return every seat with its effective status. A held seat whose hold
 * has expired is reported (and persisted) as available.
 */
export async function getSeats() {
  return inTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
         FROM seats
        ORDER BY row_label, seat_number`
    );
    return rows.map(serializeSeat);
  });
}

function serializeSeat(r) {
  return {
    id: r.id,
    row: r.row_label,
    number: r.seat_number,
    status: r.status,
    holdId: r.hold_id || null,
    holdExpiresAt: r.hold_expires_at ? new Date(r.hold_expires_at).toISOString() : null,
    bookedBy: r.booked_by || null,
  };
}

/**
 * Atomically place a hold on ALL requested seats. All-or-nothing:
 * if any requested seat is not currently available, none are held and
 * the conflicting seat ids are returned.
 */
export async function createHold(seatIds, sessionId, ttlMs) {
  const effectiveTtl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : HOLD_TTL_MS;
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    const err = new Error('seatIds must be a non-empty array');
    err.status = 400;
    throw err;
  }
  if (!sessionId || typeof sessionId !== 'string') {
    const err = new Error('sessionId is required');
    err.status = 400;
    throw err;
  }
  // De-duplicate requested seats.
  const requested = [...new Set(seatIds)];

  return inTransaction(async (tx) => {
    // Validate that all requested seat ids exist.
    const { rows: existing } = await tx.query(
      `SELECT id, status FROM seats WHERE id = ANY($1::text[])`,
      [requested]
    );
    if (existing.length !== requested.length) {
      const found = new Set(existing.map((r) => r.id));
      const unknown = requested.filter((id) => !found.has(id));
      const err = new Error(`Unknown seat ids: ${unknown.join(', ')}`);
      err.status = 400;
      throw err;
    }

    // Determine which requested seats are NOT available right now.
    const conflicts = existing
      .filter((r) => r.status !== 'available')
      .map((r) => r.id);
    if (conflicts.length > 0) {
      const err = new Error('Some seats are no longer available');
      err.status = 409;
      err.conflicts = conflicts;
      throw err;
    }

    // Atomic acquisition. The WHERE clause guards status='available' so
    // even if logic above raced, the UPDATE only touches available seats.
    const holdId = randomUUID();
    const expiresAt = new Date(Date.now() + effectiveTtl).toISOString();

    const { rows: updated } = await tx.query(
      `UPDATE seats
          SET status = 'held', hold_id = $1, hold_expires_at = $2
        WHERE id = ANY($3::text[]) AND status = 'available'
      RETURNING id`,
      [holdId, expiresAt, requested]
    );

    // If we couldn't grab every seat, roll back by throwing.
    if (updated.length !== requested.length) {
      const acquired = new Set(updated.map((r) => r.id));
      const conflict = requested.filter((id) => !acquired.has(id));
      const err = new Error('Some seats are no longer available');
      err.status = 409;
      err.conflicts = conflict;
      throw err; // transaction rolls back, releasing partial holds
    }

    await tx.query(
      `INSERT INTO holds (id, session_id, expires_at, status)
       VALUES ($1, $2, $3, 'active')`,
      [holdId, sessionId, expiresAt]
    );

    const result = {
      holdId,
      sessionId,
      seatIds: requested,
      expiresAt,
      ttlMs: effectiveTtl,
    };

    // Defer broadcast until after commit (handled by caller below).
    result.__broadcast = {
      type: 'held',
      holdId,
      seatIds: requested,
      seats: requested.map((id) => ({ id, status: 'held', holdId, holdExpiresAt: expiresAt })),
    };
    return result;
  }).then((result) => {
    if (result.__broadcast) {
      broadcast(result.__broadcast);
      delete result.__broadcast;
    }
    return result;
  });
}

/**
 * Confirm a hold: book all its seats. Idempotent — a second confirm
 * of an already-confirmed hold returns the same booking and books nothing
 * additional. Expired or unknown holds fail and book nothing.
 */
export async function confirmHold(holdId, sessionId) {
  return inTransaction(async (tx) => {
    const { rows: holdRows } = await tx.query(
      `SELECT id, session_id, expires_at, status FROM holds WHERE id = $1`,
      [holdId]
    );
    if (holdRows.length === 0) {
      const err = new Error('Hold not found');
      err.status = 404;
      throw err;
    }
    const hold = holdRows[0];

    // Optional ownership enforcement: if sessionId provided, it must match.
    if (sessionId && hold.session_id !== sessionId) {
      const err = new Error('Hold belongs to a different session');
      err.status = 403;
      throw err;
    }

    // Idempotency: already confirmed -> return existing booking.
    if (hold.status === 'confirmed') {
      const { rows: bookedSeats } = await tx.query(
        `SELECT id FROM seats WHERE hold_id = $1 AND status = 'booked'`,
        [holdId]
      );
      // Some implementations clear hold_id on booking; also check booked_by.
      let seatIds = bookedSeats.map((r) => r.id);
      if (seatIds.length === 0) {
        const { rows: byBooker } = await tx.query(
          `SELECT id FROM seats WHERE booked_by = $1 AND status = 'booked'`,
          [holdId]
        );
        seatIds = byBooker.map((r) => r.id);
      }
      return {
        holdId,
        sessionId: hold.session_id,
        seatIds,
        status: 'confirmed',
        idempotent: true,
      };
    }

    // Reject expired or otherwise inactive holds.
    if (hold.status !== 'active' || new Date(hold.expires_at).getTime() <= Date.now()) {
      // Make sure stale state is cleaned (expireStaleHolds already ran, but
      // a hold can be expired without its TTL sweep matching exactly).
      await tx.query(
        `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL
          WHERE hold_id = $1 AND status = 'held'`,
        [holdId]
      );
      await tx.query(`UPDATE holds SET status = 'expired' WHERE id = $1 AND status = 'active'`, [
        holdId,
      ]);
      const err = new Error('Hold has expired');
      err.status = 410;
      throw err;
    }

    // Verify the hold still owns its seats and they are held (not stolen).
    const { rows: heldSeats } = await tx.query(
      `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held'`,
      [holdId]
    );
    if (heldSeats.length === 0) {
      const err = new Error('Hold owns no seats');
      err.status = 409;
      throw err;
    }
    const seatIds = heldSeats.map((r) => r.id);

    // Book them. booked_by stores the hold id for traceability; we keep
    // hold_id too. Use session as the canonical owner.
    await tx.query(
      `UPDATE seats
          SET status = 'booked', booked_by = $1, hold_expires_at = NULL
        WHERE hold_id = $2 AND status = 'held'`,
      [hold.session_id, holdId]
    );
    await tx.query(`UPDATE holds SET status = 'confirmed' WHERE id = $1`, [holdId]);

    const result = {
      holdId,
      sessionId: hold.session_id,
      seatIds,
      status: 'confirmed',
      idempotent: false,
    };
    result.__broadcast = {
      type: 'booked',
      holdId,
      seatIds,
      seats: seatIds.map((id) => ({ id, status: 'booked', bookedBy: hold.session_id })),
    };
    return result;
  }).then((result) => {
    if (result.__broadcast) {
      broadcast(result.__broadcast);
      delete result.__broadcast;
    }
    return result;
  });
}

/**
 * Release a hold early, returning its seats to available.
 */
export async function releaseHold(holdId, sessionId) {
  return inTransaction(async (tx) => {
    const { rows: holdRows } = await tx.query(
      `SELECT id, session_id, status FROM holds WHERE id = $1`,
      [holdId]
    );
    if (holdRows.length === 0) {
      const err = new Error('Hold not found');
      err.status = 404;
      throw err;
    }
    const hold = holdRows[0];
    if (sessionId && hold.session_id !== sessionId) {
      const err = new Error('Hold belongs to a different session');
      err.status = 403;
      throw err;
    }
    if (hold.status === 'confirmed') {
      const err = new Error('Hold already confirmed; cannot release booked seats');
      err.status = 409;
      throw err;
    }

    const { rows: heldSeats } = await tx.query(
      `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held'`,
      [holdId]
    );
    const seatIds = heldSeats.map((r) => r.id);

    await tx.query(
      `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL
        WHERE hold_id = $1 AND status = 'held'`,
      [holdId]
    );
    await tx.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);

    const result = { holdId, seatIds, status: 'released' };
    if (seatIds.length) {
      result.__broadcast = {
        type: 'released',
        holdId,
        seatIds,
        seats: seatIds.map((id) => ({ id, status: 'available' })),
        reason: 'manual',
      };
    }
    return result;
  }).then((result) => {
    if (result.__broadcast) {
      broadcast(result.__broadcast);
      delete result.__broadcast;
    }
    return result;
  });
}

/**
 * Periodic sweep: release expired holds even if no one is reading seats.
 * Runs inside a transaction and broadcasts releases.
 */
export async function sweepExpiredHolds() {
  // expireStaleHolds runs inside inTransaction's wrapper automatically;
  // we just run a no-op body so the wrapper performs the sweep & broadcast.
  return inTransaction(async () => ({}));
}

/** Inventory accounting for diagnostics/tests. */
export async function getInventory() {
  return inTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT status, COUNT(*)::int AS count FROM seats GROUP BY status`
    );
    const counts = { available: 0, held: 0, booked: 0 };
    for (const r of rows) counts[r.status] = r.count;
    counts.total = TOTAL_SEATS;
    counts.balances = counts.available + counts.held + counts.booked === TOTAL_SEATS;
    return counts;
  });
}
