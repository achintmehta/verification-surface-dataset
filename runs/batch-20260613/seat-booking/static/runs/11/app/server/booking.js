import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { HOLD_TTL_MS } from './config.js';
import { broadcast } from './sse.js';

/**
 * Map a raw DB seat row to the effective seat view. A held seat whose hold has
 * expired is reported as available (lazy expiry on read).
 */
function effectiveSeat(row, now = Date.now()) {
  let status = row.status;
  if (
    status === 'held' &&
    row.hold_expires_at &&
    new Date(row.hold_expires_at).getTime() <= now
  ) {
    status = 'available';
  }
  return {
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: row.seat_number,
    status,
    holdId: status === 'held' ? row.hold_id : null,
    holdExpiresAt: status === 'held' ? row.hold_expires_at : null,
    bookedBy: status === 'booked' ? row.booked_by : null,
  };
}

/**
 * Release any holds whose expires_at is in the past. Runs inside its own
 * transaction. Returns the list of seat ids that were released so callers can
 * broadcast them. Safe to call frequently (lazy sweep + periodic sweep).
 */
export async function sweepExpiredHolds() {
  const db = getDb();
  let released = [];
  await db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL
       WHERE status = 'held'
         AND hold_expires_at IS NOT NULL
         AND hold_expires_at <= now()
       RETURNING id;`
    );
    released = rows.map((r) => r.id);
  });
  if (released.length > 0) {
    broadcast('seats', { type: 'released', seatIds: released });
  }
  return released;
}

/**
 * Return the effective status of every seat. Performs a sweep first so reads
 * never report a stale hold as held.
 */
export async function listSeats() {
  await sweepExpiredHolds();
  const db = getDb();
  const { rows } = await db.query(
    'SELECT * FROM seats ORDER BY row_label, seat_number;'
  );
  return rows.map((r) => effectiveSeat(r));
}

/**
 * Atomically acquire ALL requested seats for a holder if and only if every one
 * is currently available. All-or-nothing.
 *
 * @returns {{ok: true, hold: object} | {ok: false, conflicts: string[]}}
 */
export async function createHold(seatIds, sessionId) {
  const db = getDb();
  const uniqueIds = [...new Set(seatIds)];
  const holdId = randomUUID();
  const expiresAt = new Date(Date.now() + HOLD_TTL_MS);

  let result;
  let releasedDuringSweep = [];
  await db.transaction(async (tx) => {
    // Expire stale holds within the same transaction so freed seats are
    // immediately available to this acquisition.
    const { rows: released } = await tx.query(
      `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL
       WHERE status = 'held'
         AND hold_expires_at IS NOT NULL
         AND hold_expires_at <= now()
       RETURNING id;`
    );
    releasedDuringSweep = released.map((r) => r.id);

    // Lock the requested rows in a deterministic order to avoid deadlocks and
    // serialize concurrent acquisitions of the same seats.
    const { rows: locked } = await tx.query(
      `SELECT id, status FROM seats
        WHERE id = ANY($1::text[])
        ORDER BY id
        FOR UPDATE;`,
      [uniqueIds]
    );

    // Detect missing seat ids.
    const foundIds = new Set(locked.map((r) => r.id));
    const missing = uniqueIds.filter((id) => !foundIds.has(id));

    // Any seat not currently available (after expiry) is a conflict.
    const conflicts = [
      ...missing,
      ...locked.filter((r) => r.status !== 'available').map((r) => r.id),
    ];

    if (conflicts.length > 0) {
      result = { ok: false, conflicts: [...new Set(conflicts)].sort() };
      return; // transaction commits the expiry sweep; acquires nothing
    }

    // Atomic conditional update: only flips rows that are still available.
    const { rows: updated } = await tx.query(
      `UPDATE seats
         SET status = 'held', hold_id = $1, hold_expires_at = $2
       WHERE id = ANY($3::text[])
         AND status = 'available'
       RETURNING id;`,
      [holdId, expiresAt.toISOString(), uniqueIds]
    );

    // Defensive: if we didn't flip every seat, abort the whole acquisition.
    if (updated.length !== uniqueIds.length) {
      throw new Error('CONFLICT_ROLLBACK');
    }

    result = {
      ok: true,
      hold: {
        holdId,
        sessionId,
        seatIds: uniqueIds.slice().sort(),
        expiresAt: expiresAt.toISOString(),
      },
    };
  }).catch((err) => {
    if (err && err.message === 'CONFLICT_ROLLBACK') {
      // The transaction rolled back, so the in-transaction expiry sweep did
      // not commit; discard those releases.
      releasedDuringSweep = [];
      result = { ok: false, conflicts: uniqueIds.slice().sort() };
      return;
    }
    throw err;
  });

  if (releasedDuringSweep.length > 0) {
    broadcast('seats', { type: 'released', seatIds: releasedDuringSweep });
  }
  if (result.ok) {
    broadcast('seats', {
      type: 'held',
      seatIds: result.hold.seatIds,
      holdId,
      expiresAt: result.hold.expiresAt,
    });
  }
  return result;
}

/**
 * Confirm a hold within a single transaction. Idempotent: confirming an
 * already-booked hold returns the same booking and books nothing additional.
 *
 * @returns {{ok:true, booking:object, idempotent:boolean} |
 *           {ok:false, reason:string}}
 */
export async function confirmHold(holdId, sessionId) {
  const db = getDb();
  let result;
  let releasedDuringSweep = [];

  await db.transaction(async (tx) => {
    // Expire stale holds first.
    const { rows: released } = await tx.query(
      `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL
       WHERE status = 'held'
         AND hold_expires_at IS NOT NULL
         AND hold_expires_at <= now()
       RETURNING id;`
    );
    releasedDuringSweep = released.map((r) => r.id);

    // Lock all seats associated with this hold id (held or already booked).
    const { rows: seats } = await tx.query(
      `SELECT id, status, booked_by FROM seats
        WHERE hold_id = $1
        ORDER BY id
        FOR UPDATE;`,
      [holdId]
    );

    if (seats.length === 0) {
      // No seats currently reference this hold. Either it never existed, or it
      // expired (and was just released above), or it was already booked under
      // this hold id but hold_id cleared. We treat as unknown/expired.
      result = { ok: false, reason: 'hold_not_found_or_expired' };
      return;
    }

    const allBooked = seats.every((s) => s.status === 'booked');
    const allHeld = seats.every((s) => s.status === 'held');

    if (allBooked) {
      // Idempotent re-confirm.
      result = {
        ok: true,
        idempotent: true,
        booking: {
          holdId,
          seatIds: seats.map((s) => s.id).sort(),
          bookedBy: seats[0].booked_by,
        },
      };
      return;
    }

    if (!allHeld) {
      // Mixed/invalid state -> nothing to book safely.
      result = { ok: false, reason: 'hold_invalid_state' };
      return;
    }

    // All seats are held under this hold -> book them. Note: we keep hold_id so
    // a repeat confirm can find the booked seats and return idempotently.
    const { rows: booked } = await tx.query(
      `UPDATE seats
         SET status = 'booked',
             booked_by = $2,
             hold_expires_at = NULL
       WHERE hold_id = $1
         AND status = 'held'
       RETURNING id;`,
      [holdId, sessionId]
    );

    result = {
      ok: true,
      idempotent: false,
      booking: {
        holdId,
        seatIds: booked.map((r) => r.id).sort(),
        bookedBy: sessionId,
      },
    };
  });

  // Broadcast any releases discovered during the sweep.
  if (releasedDuringSweep.length > 0) {
    broadcast('seats', { type: 'released', seatIds: releasedDuringSweep });
  }
  if (result && result.ok && !result.idempotent) {
    broadcast('seats', {
      type: 'booked',
      seatIds: result.booking.seatIds,
      holdId,
    });
  }
  return result;
}

/**
 * Release a hold early, returning its held seats to available. Does not affect
 * booked seats. Idempotent.
 */
export async function releaseHold(holdId) {
  const db = getDb();
  let released = [];
  await db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL
       WHERE hold_id = $1
         AND status = 'held'
       RETURNING id;`,
      [holdId]
    );
    released = rows.map((r) => r.id);
  });
  if (released.length > 0) {
    broadcast('seats', { type: 'released', seatIds: released });
  }
  return { ok: true, seatIds: released.sort() };
}
