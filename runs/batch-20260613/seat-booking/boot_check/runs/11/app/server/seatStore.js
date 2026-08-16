import { randomUUID } from 'crypto';
import { getDb } from './db.js';
import { HOLD_TTL_MS } from './config.js';
import { broadcastSeatUpdates } from './sse.js';

/**
 * Map an internal seat row to the public effective representation.
 * A held seat whose hold has expired is reported as available.
 */
function effectiveSeat(seat, now = new Date()) {
  let status = seat.status;
  if (
    status === 'held' &&
    seat.hold_expires_at &&
    new Date(seat.hold_expires_at).getTime() <= now.getTime()
  ) {
    status = 'available';
  }
  return {
    id: seat.id,
    row: seat.row_label,
    number: seat.seat_number,
    status,
    holdId: status === 'held' ? seat.hold_id : null,
    holdExpiresAt: status === 'held' ? seat.hold_expires_at : null,
    bookedBy: status === 'booked' ? seat.booked_by : null,
  };
}

/**
 * Release every seat whose hold has expired, in a single transaction.
 * Returns the list of seat ids that were released (so they can be broadcast).
 * Safe to call frequently — it is a no-op when nothing has expired.
 */
export async function expireStaleHolds() {
  const db = getDb();
  let released = [];

  await db.transaction(async (tx) => {
    // Mark expired holds (active holds whose time has passed).
    await tx.query(
      `UPDATE holds SET status = 'expired'
       WHERE status = 'active' AND expires_at <= now()`
    );

    // Release seats whose hold expired.
    const { rows } = await tx.query(
      `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL
       WHERE status = 'held'
         AND hold_expires_at IS NOT NULL
         AND hold_expires_at <= now()
       RETURNING id, row_label, seat_number, status`
    );
    released = rows;
  });

  if (released.length > 0) {
    broadcastSeatUpdates(
      released.map((s) => ({ id: s.id, status: 'available' }))
    );
  }
  return released.map((s) => s.id);
}

/**
 * Return all seats with their effective status.
 */
export async function getSeats() {
  // Enforce expiry on every read.
  await expireStaleHolds();
  const db = getDb();
  const { rows } = await db.query(
    `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
       FROM seats ORDER BY id`
  );
  const now = new Date();
  return rows.map((s) => effectiveSeat(s, now));
}

/**
 * Atomically acquire ALL requested seats for a session.
 * All-or-nothing: if any requested seat is not currently available,
 * none are acquired and a conflict is returned.
 *
 * @returns {{ ok: true, hold: object, seats: object[] } | { ok: false, conflicts: number[] }}
 */
export async function createHold(seatIds, sessionId) {
  const db = getDb();

  // Normalize / validate input ids.
  const ids = [...new Set(seatIds.map((n) => Number(n)))].filter(
    (n) => Number.isInteger(n)
  );
  if (ids.length === 0) {
    return { ok: false, conflicts: [], error: 'No valid seat ids supplied' };
  }

  const holdId = randomUUID();
  const expiresAt = new Date(Date.now() + HOLD_TTL_MS);

  let result;

  await db.transaction(async (tx) => {
    // First, lazily expire stale holds inside the same transaction so that
    // a just-expired seat is considered available for this acquisition.
    await tx.query(
      `UPDATE holds SET status = 'expired'
       WHERE status = 'active' AND expires_at <= now()`
    );
    const expiredSeats = await tx.query(
      `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL
       WHERE status = 'held'
         AND hold_expires_at IS NOT NULL
         AND hold_expires_at <= now()
       RETURNING id`
    );

    // Lock the requested rows and check availability atomically.
    // FOR UPDATE serializes concurrent transactions touching these rows.
    const { rows: locked } = await tx.query(
      `SELECT id, status, hold_expires_at
         FROM seats
        WHERE id = ANY($1::int[])
        ORDER BY id
        FOR UPDATE`,
      [ids]
    );

    const foundIds = new Set(locked.map((r) => r.id));
    const missing = ids.filter((id) => !foundIds.has(id));

    const now = Date.now();
    const conflicts = [];
    for (const seat of locked) {
      const effExpired =
        seat.status === 'held' &&
        seat.hold_expires_at &&
        new Date(seat.hold_expires_at).getTime() <= now;
      const available = seat.status === 'available' || effExpired;
      if (!available) conflicts.push(seat.id);
    }

    if (missing.length > 0 || conflicts.length > 0) {
      result = {
        ok: false,
        conflicts: [...conflicts, ...missing].sort((a, b) => a - b),
        expiredReleased: expiredSeats.rows.map((r) => r.id),
      };
      return; // transaction commits the harmless expiry work
    }

    // Create the hold and mark the seats held.
    await tx.query(
      `INSERT INTO holds (id, session_id, expires_at, status)
       VALUES ($1, $2, $3, 'active')`,
      [holdId, sessionId, expiresAt.toISOString()]
    );

    const { rows: updated } = await tx.query(
      `UPDATE seats
         SET status = 'held', hold_id = $1, hold_expires_at = $2, booked_by = NULL
       WHERE id = ANY($3::int[])
       RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at`,
      [holdId, expiresAt.toISOString(), ids]
    );

    result = {
      ok: true,
      hold: {
        id: holdId,
        sessionId,
        expiresAt: expiresAt.toISOString(),
        seatIds: ids,
      },
      seats: updated,
      expiredReleased: expiredSeats.rows.map((r) => r.id),
    };
  });

  // Broadcast any expiry-driven releases that happened during the txn.
  if (result.expiredReleased && result.expiredReleased.length > 0) {
    broadcastSeatUpdates(
      result.expiredReleased.map((id) => ({ id, status: 'available' }))
    );
  }

  if (result.ok) {
    broadcastSeatUpdates(
      result.seats.map((s) => ({
        id: s.id,
        status: 'held',
        holdExpiresAt: s.hold_expires_at,
      }))
    );
  }

  return result;
}

/**
 * Confirm a hold: book its seats. Idempotent.
 * @returns {{ ok: true, booking: object } | { ok: false, error: string }}
 */
export async function confirmHold(holdId) {
  const db = getDb();
  let result;

  await db.transaction(async (tx) => {
    // Expire stale holds first.
    await tx.query(
      `UPDATE holds SET status = 'expired'
       WHERE status = 'active' AND expires_at <= now()`
    );
    const expiredSeats = await tx.query(
      `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL
       WHERE status = 'held'
         AND hold_expires_at IS NOT NULL
         AND hold_expires_at <= now()
       RETURNING id`
    );

    // Lock the hold row.
    const { rows: holdRows } = await tx.query(
      `SELECT id, session_id, expires_at, status
         FROM holds WHERE id = $1 FOR UPDATE`,
      [holdId]
    );

    if (holdRows.length === 0) {
      result = { ok: false, status: 404, error: 'Hold not found' };
      result.expiredReleased = expiredSeats.rows.map((r) => r.id);
      return;
    }

    const hold = holdRows[0];

    // Idempotency: a hold already confirmed returns the same booking.
    if (hold.status === 'confirmed') {
      const { rows: bookedSeats } = await tx.query(
        `SELECT id, row_label, seat_number FROM seats
          WHERE status = 'booked' AND hold_id = $1 ORDER BY id`,
        [holdId]
      );
      result = {
        ok: true,
        idempotent: true,
        booking: {
          holdId,
          sessionId: hold.session_id,
          seatIds: bookedSeats.map((s) => s.id),
        },
        bookedSeats,
      };
      result.expiredReleased = expiredSeats.rows.map((r) => r.id);
      return;
    }

    // Reject expired/released holds.
    if (hold.status !== 'active') {
      result = {
        ok: false,
        status: 409,
        error: `Hold is ${hold.status} and cannot be confirmed`,
      };
      result.expiredReleased = expiredSeats.rows.map((r) => r.id);
      return;
    }

    if (new Date(hold.expires_at).getTime() <= Date.now()) {
      result = { ok: false, status: 409, error: 'Hold has expired' };
      result.expiredReleased = expiredSeats.rows.map((r) => r.id);
      return;
    }

    // Re-validate that the hold still owns its seats and they are held.
    const { rows: ownedSeats } = await tx.query(
      `SELECT id, row_label, seat_number, status
         FROM seats
        WHERE hold_id = $1
        ORDER BY id
        FOR UPDATE`,
      [holdId]
    );

    const stillHeld = ownedSeats.filter((s) => s.status === 'held');
    if (stillHeld.length === 0) {
      result = {
        ok: false,
        status: 409,
        error: 'Hold no longer owns any seats',
      };
      result.expiredReleased = expiredSeats.rows.map((r) => r.id);
      return;
    }

    // Book the seats, keeping hold_id for idempotent re-confirmation lookups.
    const seatIds = stillHeld.map((s) => s.id);
    const { rows: booked } = await tx.query(
      `UPDATE seats
         SET status = 'booked',
             booked_by = $1,
             hold_expires_at = NULL
       WHERE id = ANY($2::int[])
       RETURNING id, row_label, seat_number, status`,
      [hold.session_id, seatIds]
    );

    await tx.query(`UPDATE holds SET status = 'confirmed' WHERE id = $1`, [
      holdId,
    ]);

    result = {
      ok: true,
      idempotent: false,
      booking: {
        holdId,
        sessionId: hold.session_id,
        seatIds,
      },
      bookedSeats: booked,
    };
    result.expiredReleased = expiredSeats.rows.map((r) => r.id);
  });

  if (result.expiredReleased && result.expiredReleased.length > 0) {
    broadcastSeatUpdates(
      result.expiredReleased.map((id) => ({ id, status: 'available' }))
    );
  }

  if (result.ok && !result.idempotent && result.bookedSeats) {
    broadcastSeatUpdates(
      result.bookedSeats.map((s) => ({ id: s.id, status: 'booked' }))
    );
  }

  return result;
}

/**
 * Release a hold early, returning its seats to available. Idempotent.
 * @returns {{ ok: true, releasedSeatIds: number[] } | { ok: false, error: string }}
 */
export async function releaseHold(holdId) {
  const db = getDb();
  let result;

  await db.transaction(async (tx) => {
    const { rows: holdRows } = await tx.query(
      `SELECT id, status FROM holds WHERE id = $1 FOR UPDATE`,
      [holdId]
    );

    if (holdRows.length === 0) {
      result = { ok: false, status: 404, error: 'Hold not found' };
      return;
    }

    const hold = holdRows[0];

    if (hold.status === 'confirmed') {
      result = {
        ok: false,
        status: 409,
        error: 'Hold already confirmed; cannot release booked seats',
      };
      return;
    }

    // Release only seats that are still held by this hold.
    const { rows: released } = await tx.query(
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

    result = { ok: true, releasedSeatIds: released.map((r) => r.id) };
  });

  if (result.ok && result.releasedSeatIds.length > 0) {
    broadcastSeatUpdates(
      result.releasedSeatIds.map((id) => ({ id, status: 'available' }))
    );
  }

  return result;
}

/**
 * Compute inventory counts (available / held(active) / booked).
 */
export async function getInventory() {
  await expireStaleHolds();
  const db = getDb();
  const { rows } = await db.query(
    `SELECT
        SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END)::int AS available,
        SUM(CASE WHEN status = 'held' THEN 1 ELSE 0 END)::int AS held,
        SUM(CASE WHEN status = 'booked' THEN 1 ELSE 0 END)::int AS booked,
        COUNT(*)::int AS total
      FROM seats`
  );
  return rows[0];
}
