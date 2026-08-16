import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { broadcast } from './sse.js';

const HOLD_TTL_MS = 60 * 1000; // 60 seconds

export function getHoldTtlMs() {
  return HOLD_TTL_MS;
}

/**
 * Lazily expire holds whose expires_at is in the past.
 * Releases their seats back to available. Returns the list of affected seat ids.
 * Runs inside a transaction-safe context (uses provided tx or db).
 */
async function expireStaleHoldsTx(tx) {
  // Find seats that are 'held' but expired.
  const { rows: expiredSeats } = await tx.query(
    `SELECT id FROM seats
       WHERE status = 'held'
         AND hold_expires_at IS NOT NULL
         AND hold_expires_at <= now()`
  );

  if (expiredSeats.length > 0) {
    await tx.query(
      `UPDATE seats
          SET status = 'available', hold_id = NULL, hold_expires_at = NULL
        WHERE status = 'held'
          AND hold_expires_at IS NOT NULL
          AND hold_expires_at <= now()`
    );
  }

  // Mark hold rows expired
  await tx.query(
    `UPDATE holds SET status = 'expired'
       WHERE status = 'active' AND expires_at <= now()`
  );

  return expiredSeats.map((r) => r.id);
}

/**
 * Run the lazy expiry sweep in its own transaction and broadcast releases.
 */
export async function sweepExpired() {
  const db = await getDb();
  let released = [];
  await db.transaction(async (tx) => {
    released = await expireStaleHoldsTx(tx);
  });
  if (released.length > 0) {
    broadcast('seats', { type: 'released', seatIds: released });
  }
  return released;
}

/** Return all seats with effective status (expired holds reported as available). */
export async function getSeats() {
  // First lazily sweep so DB reflects reality, then read.
  await sweepExpired();
  const db = await getDb();
  const { rows } = await db.query(
    `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
       FROM seats
       ORDER BY row_label, seat_number`
  );
  return rows.map((s) => ({
    id: s.id,
    row: s.row_label,
    number: s.seat_number,
    status: s.status,
    holdId: s.hold_id,
    holdExpiresAt: s.hold_expires_at,
    bookedBy: s.booked_by,
  }));
}

/**
 * Atomically acquire ALL requested seats only if every one is currently available.
 * All-or-nothing. Returns { ok: true, hold } or { ok:false, conflicts:[...] }.
 */
export async function createHold(seatIds, sessionId) {
  const db = await getDb();
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return { ok: false, error: 'seatIds required' };
  }
  if (!sessionId) {
    return { ok: false, error: 'sessionId required' };
  }
  // Deduplicate
  const ids = [...new Set(seatIds)];

  const holdId = randomUUID();
  const result = { ok: false };

  await db.transaction(async (tx) => {
    // Enforce expiry first so previously-held-but-expired seats are acquirable.
    const releasedBySweep = await expireStaleHoldsTx(tx);
    if (releasedBySweep.length > 0) {
      result._released = releasedBySweep;
    }

    // Lock the requested seat rows to serialize concurrent requests.
    const { rows: seatRows } = await tx.query(
      `SELECT id, status FROM seats WHERE id = ANY($1) FOR UPDATE`,
      [ids]
    );

    // Validate every requested id exists.
    const found = new Set(seatRows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      result.ok = false;
      result.error = 'unknown seat ids';
      result.conflicts = missing;
      return; // transaction commits the sweep but acquires no seats
    }

    // Any seat not available -> conflict, acquire none.
    const conflicts = seatRows
      .filter((r) => r.status !== 'available')
      .map((r) => r.id);
    if (conflicts.length > 0) {
      result.ok = false;
      result.conflicts = conflicts;
      return;
    }

    // All available: create the hold and mark seats held.
    const expiresAtRes = await tx.query(
      `INSERT INTO holds (id, session_id, expires_at, status)
       VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval, 'active')
       RETURNING id, session_id, created_at, expires_at, status`,
      [holdId, sessionId, String(HOLD_TTL_MS)]
    );
    const hold = expiresAtRes.rows[0];

    await tx.query(
      `UPDATE seats
          SET status = 'held', hold_id = $1, hold_expires_at = $2
        WHERE id = ANY($3)`,
      [holdId, hold.expires_at, ids]
    );

    result.ok = true;
    result.hold = {
      id: hold.id,
      sessionId: hold.session_id,
      seatIds: ids,
      expiresAt: hold.expires_at,
      status: hold.status,
    };
  });

  // Broadcast outside transaction
  if (result._released && result._released.length > 0) {
    broadcast('seats', { type: 'released', seatIds: result._released });
  }
  if (result.ok) {
    broadcast('seats', {
      type: 'held',
      seatIds: result.hold.seatIds,
      holdExpiresAt: result.hold.expiresAt,
    });
  }
  delete result._released;
  return result;
}

/**
 * Confirm a hold: verify exists, active, not expired, owns its seats, then book.
 * Idempotent: a second confirm returns the same booking and books nothing more.
 */
export async function confirmHold(holdId) {
  const db = await getDb();
  const result = { ok: false };

  await db.transaction(async (tx) => {
    await expireStaleHoldsTx(tx);

    const { rows: holdRows } = await tx.query(
      `SELECT id, session_id, expires_at, status FROM holds WHERE id = $1 FOR UPDATE`,
      [holdId]
    );

    if (holdRows.length === 0) {
      result.ok = false;
      result.error = 'unknown hold';
      result.status = 404;
      return;
    }
    const hold = holdRows[0];

    // Idempotency: already confirmed -> return existing booking.
    if (hold.status === 'confirmed') {
      const { rows: bookedSeats } = await tx.query(
        `SELECT id FROM seats WHERE booked_by = $1 ORDER BY row_label, seat_number`,
        [holdId]
      );
      result.ok = true;
      result.idempotent = true;
      result.booking = {
        holdId,
        sessionId: hold.session_id,
        seatIds: bookedSeats.map((r) => r.id),
        status: 'confirmed',
      };
      return;
    }

    if (hold.status !== 'active') {
      result.ok = false;
      result.error = `hold is ${hold.status}`;
      result.status = 409;
      return;
    }

    // Re-validate expiry inside the transaction.
    const { rows: expCheck } = await tx.query(
      `SELECT (expires_at <= now()) AS expired FROM holds WHERE id = $1`,
      [holdId]
    );
    if (expCheck[0].expired) {
      result.ok = false;
      result.error = 'hold expired';
      result.status = 409;
      return;
    }

    // Verify the hold still owns active held seats.
    const { rows: ownedSeats } = await tx.query(
      `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held' FOR UPDATE`,
      [holdId]
    );
    if (ownedSeats.length === 0) {
      result.ok = false;
      result.error = 'hold owns no seats';
      result.status = 409;
      return;
    }
    const seatIds = ownedSeats.map((r) => r.id);

    await tx.query(
      `UPDATE seats
          SET status = 'booked', booked_by = $1, hold_expires_at = NULL
        WHERE hold_id = $1 AND status = 'held'`,
      [holdId]
    );
    await tx.query(`UPDATE holds SET status = 'confirmed' WHERE id = $1`, [holdId]);

    result.ok = true;
    result.booking = {
      holdId,
      sessionId: hold.session_id,
      seatIds,
      status: 'confirmed',
    };
  });

  if (result.ok && !result.idempotent) {
    broadcast('seats', { type: 'booked', seatIds: result.booking.seatIds });
  }
  return result;
}

/** Release a hold early; returns its seats to available. */
export async function releaseHold(holdId) {
  const db = await getDb();
  const result = { ok: false };

  await db.transaction(async (tx) => {
    const { rows: holdRows } = await tx.query(
      `SELECT id, status FROM holds WHERE id = $1 FOR UPDATE`,
      [holdId]
    );
    if (holdRows.length === 0) {
      result.ok = false;
      result.error = 'unknown hold';
      result.status = 404;
      return;
    }
    const hold = holdRows[0];

    if (hold.status === 'confirmed') {
      result.ok = false;
      result.error = 'hold already confirmed';
      result.status = 409;
      return;
    }

    const { rows: heldSeats } = await tx.query(
      `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held' FOR UPDATE`,
      [holdId]
    );
    const seatIds = heldSeats.map((r) => r.id);

    await tx.query(
      `UPDATE seats
          SET status = 'available', hold_id = NULL, hold_expires_at = NULL
        WHERE hold_id = $1 AND status = 'held'`,
      [holdId]
    );
    await tx.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);

    result.ok = true;
    result.seatIds = seatIds;
  });

  if (result.ok && result.seatIds.length > 0) {
    broadcast('seats', { type: 'released', seatIds: result.seatIds });
  }
  return result;
}

/** Inventory counts that always reconcile to TOTAL_SEATS. */
export async function getInventory() {
  await sweepExpired();
  const db = await getDb();
  const { rows } = await db.query(
    `SELECT status, COUNT(*)::int AS count FROM seats GROUP BY status`
  );
  const inv = { available: 0, held: 0, booked: 0 };
  for (const r of rows) inv[r.status] = r.count;
  inv.total = inv.available + inv.held + inv.booked;
  return inv;
}
