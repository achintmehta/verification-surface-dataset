import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { HOLD_TTL_MS } from './config.js';
import { broadcastSeatUpdate } from './sse.js';

/**
 * The booking module implements all correctness-critical logic:
 *  - lazy expiry (releasing stale holds on read and before every operation)
 *  - atomic all-or-nothing seat acquisition
 *  - idempotent, transactional confirmation
 *  - early release
 *
 * Every operation runs inside a single PGLite transaction. PGLite executes
 * transactions serially (single connection), which together with the
 * conditional UPDATEs guarantees no seat can be acquired by two requests.
 */

/**
 * Map a raw seat row to its *effective* status, treating an expired hold as
 * available. Used for read responses. Note: lazy expiry (below) also mutates
 * the rows so the stored state converges.
 */
function effectiveSeat(row, now = Date.now()) {
  let status = row.status;
  if (status === 'held' && row.hold_expires_at) {
    const exp = new Date(row.hold_expires_at).getTime();
    if (exp <= now) status = 'available';
  }
  return {
    id: row.id,
    row: row.row_label,
    number: row.seat_number,
    status,
    holdId: status === 'held' ? row.hold_id : null,
    holdExpiresAt: status === 'held' ? row.hold_expires_at : null,
    bookedBy: status === 'booked' ? row.booked_by : null,
  };
}

/**
 * Release all expired holds inside the given transaction. Returns the list of
 * seats that were released (with their new effective status 'available'), so
 * the caller can broadcast them.
 *
 * MUST be called at the start of every operation that reads or mutates seats.
 */
async function releaseExpiredHolds(tx) {
  // Find seats currently held whose hold has expired.
  const { rows: expiredSeats } = await tx.query(
    `SELECT id, row_label, seat_number
       FROM seats
      WHERE status = 'held'
        AND hold_expires_at IS NOT NULL
        AND hold_expires_at <= now()`,
  );

  if (expiredSeats.length === 0) return [];

  // Release the seats.
  await tx.query(
    `UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE status = 'held'
        AND hold_expires_at IS NOT NULL
        AND hold_expires_at <= now()`,
  );

  // Mark the corresponding holds as expired.
  await tx.query(
    `UPDATE holds
        SET status = 'expired'
      WHERE status = 'active'
        AND expires_at <= now()`,
  );

  return expiredSeats.map((s) => ({
    id: s.id,
    row: s.row_label,
    number: s.seat_number,
    status: 'available',
  }));
}

/**
 * Read the full seat map with effective status. Performs lazy expiry first.
 */
export async function getSeats() {
  const db = getDb();
  let released = [];
  let seats = [];

  await db.transaction(async (tx) => {
    released = await releaseExpiredHolds(tx);
    const { rows } = await tx.query(
      'SELECT * FROM seats ORDER BY row_label, seat_number',
    );
    seats = rows.map((r) => effectiveSeat(r));
  });

  if (released.length > 0) broadcastSeatUpdate(released, 'released');
  return seats;
}

/**
 * Compute inventory counts (available + active held + booked == total).
 */
export async function getInventory() {
  const seats = await getSeats();
  const counts = { available: 0, held: 0, booked: 0, total: seats.length };
  for (const s of seats) counts[s.status]++;
  return counts;
}

export class BookingError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/**
 * Atomically acquire ALL requested seats for a session. All-or-nothing:
 * if any requested seat is unavailable, none are acquired and a 409 is thrown
 * with the conflicting seat ids.
 *
 * @param {number[]} seatIds
 * @param {string} sessionId
 * @returns {Promise<{ holdId, expiresAt, seatIds }>}
 */
export async function createHold(seatIds, sessionId) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    throw new BookingError(400, 'invalid_request', 'seatIds must be a non-empty array');
  }
  if (!sessionId || typeof sessionId !== 'string') {
    throw new BookingError(400, 'invalid_request', 'sessionId is required');
  }

  // Normalize to unique integers.
  const ids = [...new Set(seatIds.map((n) => Number(n)))];
  if (ids.some((n) => !Number.isInteger(n))) {
    throw new BookingError(400, 'invalid_request', 'seatIds must be integers');
  }

  const db = getDb();
  const holdId = randomUUID();
  const expiresAtMs = Date.now() + HOLD_TTL_MS;
  const expiresAtIso = new Date(expiresAtMs).toISOString();

  let releasedBroadcast = [];
  let heldBroadcast = [];
  let result;

  await db.transaction(async (tx) => {
    // 1. Lazy expiry first so freshly-expired seats can be re-acquired.
    releasedBroadcast = await releaseExpiredHolds(tx);

    // 2. Lock and read the requested seats. PGLite serializes transactions,
    //    but we still use FOR UPDATE for explicit row locking semantics.
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    const { rows: requested } = await tx.query(
      `SELECT id, status, hold_expires_at FROM seats
        WHERE id IN (${placeholders})
        FOR UPDATE`,
      ids,
    );

    // 3. Validate every requested seat exists.
    const foundIds = new Set(requested.map((r) => r.id));
    const missing = ids.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new BookingError(404, 'unknown_seats', 'Some seats do not exist', {
        unknownSeatIds: missing,
      });
    }

    // 4. Determine conflicts: any seat not effectively available.
    const now = Date.now();
    const conflicts = requested
      .filter((r) => {
        if (r.status === 'available') return false;
        if (
          r.status === 'held' &&
          r.hold_expires_at &&
          new Date(r.hold_expires_at).getTime() <= now
        ) {
          return false; // expired hold => available
        }
        return true;
      })
      .map((r) => r.id);

    if (conflicts.length > 0) {
      // All-or-nothing: acquire none.
      throw new BookingError(409, 'seats_unavailable', 'Some seats are unavailable', {
        conflictingSeatIds: conflicts,
      });
    }

    // 5. Create the hold record.
    await tx.query(
      `INSERT INTO holds (id, session_id, expires_at, status)
       VALUES ($1, $2, $3, 'active')`,
      [holdId, sessionId, expiresAtIso],
    );

    // 6. Atomically mark seats held. Guarded condition ensures we only flip
    //    seats that are still available (defense in depth).
    const updatePlaceholders = ids.map((_, i) => `$${i + 3}`).join(', ');
    const { rows: updated } = await tx.query(
      `UPDATE seats
          SET status = 'held', hold_id = $1, hold_expires_at = $2
        WHERE id IN (${updatePlaceholders})
          AND status = 'available'
        RETURNING id, row_label, seat_number`,
      [holdId, expiresAtIso, ...ids],
    );

    if (updated.length !== ids.length) {
      // A seat slipped away between read and update — abort the whole hold.
      throw new BookingError(409, 'seats_unavailable', 'Some seats are unavailable', {
        conflictingSeatIds: ids.filter(
          (id) => !updated.some((u) => u.id === id),
        ),
      });
    }

    heldBroadcast = updated.map((u) => ({
      id: u.id,
      row: u.row_label,
      number: u.seat_number,
      status: 'held',
      holdId,
      holdExpiresAt: expiresAtIso,
    }));

    result = { holdId, expiresAt: expiresAtIso, seatIds: ids, sessionId };
  });

  // Broadcast after the transaction commits.
  if (releasedBroadcast.length > 0) broadcastSeatUpdate(releasedBroadcast, 'released');
  if (heldBroadcast.length > 0) broadcastSeatUpdate(heldBroadcast, 'held');

  return result;
}

/**
 * Confirm a hold, booking its seats permanently. Transactional and idempotent.
 * Re-validates existence, ownership, and expiry inside the transaction.
 *
 * @param {string} holdId
 * @returns {Promise<{ holdId, status, seatIds }>}
 */
export async function confirmHold(holdId) {
  if (!holdId || typeof holdId !== 'string') {
    throw new BookingError(400, 'invalid_request', 'holdId is required');
  }

  const db = getDb();
  let releasedBroadcast = [];
  let bookedBroadcast = [];
  let result;

  await db.transaction(async (tx) => {
    // 1. Lazy expiry first.
    releasedBroadcast = await releaseExpiredHolds(tx);

    // 2. Load and lock the hold.
    const { rows: holdRows } = await tx.query(
      'SELECT * FROM holds WHERE id = $1 FOR UPDATE',
      [holdId],
    );

    if (holdRows.length === 0) {
      throw new BookingError(404, 'unknown_hold', 'Hold not found');
    }
    const hold = holdRows[0];

    // 3. Idempotency: already confirmed => return the same booking.
    if (hold.status === 'confirmed') {
      const { rows: seats } = await tx.query(
        `SELECT id FROM seats WHERE booked_by = $1 ORDER BY id`,
        [holdId],
      );
      result = {
        holdId,
        status: 'confirmed',
        seatIds: seats.map((s) => s.id),
        idempotent: true,
      };
      return;
    }

    // 4. Reject expired or otherwise non-active holds. The lazy expiry above
    //    will already have marked timed-out holds as 'expired'.
    if (hold.status !== 'active') {
      throw new BookingError(410, 'hold_expired', 'Hold is no longer active');
    }
    if (new Date(hold.expires_at).getTime() <= Date.now()) {
      // Defensive: expire it now.
      await tx.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [holdId]);
      throw new BookingError(410, 'hold_expired', 'Hold has expired');
    }

    // 5. Book the seats this hold still owns (status held + matching hold_id).
    const { rows: booked } = await tx.query(
      `UPDATE seats
          SET status = 'booked', booked_by = $1, hold_id = NULL, hold_expires_at = NULL
        WHERE hold_id = $1 AND status = 'held'
        RETURNING id, row_label, seat_number`,
      [holdId],
    );

    if (booked.length === 0) {
      // The hold owns no seats anymore (released/stolen). Nothing to book.
      await tx.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [holdId]);
      throw new BookingError(409, 'no_seats', 'Hold owns no seats to confirm');
    }

    await tx.query(`UPDATE holds SET status = 'confirmed' WHERE id = $1`, [holdId]);

    bookedBroadcast = booked.map((b) => ({
      id: b.id,
      row: b.row_label,
      number: b.seat_number,
      status: 'booked',
    }));

    result = {
      holdId,
      status: 'confirmed',
      seatIds: booked.map((b) => b.id),
      idempotent: false,
    };
  });

  if (releasedBroadcast.length > 0) broadcastSeatUpdate(releasedBroadcast, 'released');
  if (bookedBroadcast.length > 0) broadcastSeatUpdate(bookedBroadcast, 'booked');

  return result;
}

/**
 * Release a hold early, returning its seats to available.
 *
 * @param {string} holdId
 * @returns {Promise<{ holdId, status, releasedSeatIds }>}
 */
export async function releaseHold(holdId) {
  if (!holdId || typeof holdId !== 'string') {
    throw new BookingError(400, 'invalid_request', 'holdId is required');
  }

  const db = getDb();
  let releasedBroadcast = [];
  let earlyReleaseBroadcast = [];
  let result;

  await db.transaction(async (tx) => {
    releasedBroadcast = await releaseExpiredHolds(tx);

    const { rows: holdRows } = await tx.query(
      'SELECT * FROM holds WHERE id = $1 FOR UPDATE',
      [holdId],
    );
    if (holdRows.length === 0) {
      throw new BookingError(404, 'unknown_hold', 'Hold not found');
    }
    const hold = holdRows[0];

    if (hold.status === 'confirmed') {
      throw new BookingError(409, 'already_confirmed', 'Hold already confirmed; cannot release booked seats');
    }

    // Release any seats still held by this hold.
    const { rows: released } = await tx.query(
      `UPDATE seats
          SET status = 'available', hold_id = NULL, hold_expires_at = NULL
        WHERE hold_id = $1 AND status = 'held'
        RETURNING id, row_label, seat_number`,
      [holdId],
    );

    await tx.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);

    earlyReleaseBroadcast = released.map((r) => ({
      id: r.id,
      row: r.row_label,
      number: r.seat_number,
      status: 'available',
    }));

    result = {
      holdId,
      status: 'released',
      releasedSeatIds: released.map((r) => r.id),
    };
  });

  if (releasedBroadcast.length > 0) broadcastSeatUpdate(releasedBroadcast, 'released');
  if (earlyReleaseBroadcast.length > 0) broadcastSeatUpdate(earlyReleaseBroadcast, 'released');

  return result;
}

/**
 * Periodic sweep: release stale holds even with no read traffic, and broadcast.
 */
export async function sweepExpiredHolds() {
  const db = getDb();
  let released = [];
  await db.transaction(async (tx) => {
    released = await releaseExpiredHolds(tx);
  });
  if (released.length > 0) broadcastSeatUpdate(released, 'released');
  return released;
}
