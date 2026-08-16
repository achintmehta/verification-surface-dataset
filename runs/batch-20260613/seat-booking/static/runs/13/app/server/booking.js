import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { HOLD_TTL_MS } from './config.js';
import { broadcastSeatUpdates } from './sse.js';

/**
 * Booking domain logic.
 *
 * Concurrency correctness relies on three things:
 *  - All mutating operations run inside a PGLite transaction (db.transaction),
 *    which serializes them so check-and-set on seats is atomic.
 *  - Holds carry an `expires_at`; expiry is enforced (lazily) on every read and
 *    before every hold/confirm by releasing seats whose hold has elapsed.
 *  - Confirmation re-validates the hold inside the transaction and is idempotent.
 */

const PUBLIC_SEAT_COLUMNS =
  'id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by';

/**
 * Compute the effective, client-facing status of a seat row. A seat marked
 * 'held' whose hold has expired is effectively 'available'.
 */
function effectiveStatus(seat, now = Date.now()) {
  if (
    seat.status === 'held' &&
    seat.hold_expires_at &&
    new Date(seat.hold_expires_at).getTime() <= now
  ) {
    return 'available';
  }
  return seat.status;
}

/**
 * Map an internal seat row to the public shape sent to clients, with
 * effective status applied.
 */
function toPublicSeat(seat) {
  const status = effectiveStatus(seat);
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
 * Release every seat whose hold has expired. Runs inside the provided tx (or a
 * fresh one). Returns the list of released seat rows (public shape) for
 * broadcasting. Marks the associated holds as expired.
 */
async function releaseExpiredSeats(tx) {
  const { rows } = await tx.query(
    `UPDATE seats
        SET status = 'available',
            hold_id = NULL,
            hold_expires_at = NULL
      WHERE status = 'held'
        AND hold_expires_at IS NOT NULL
        AND hold_expires_at <= now()
      RETURNING ${PUBLIC_SEAT_COLUMNS}`,
  );

  await tx.query(
    `UPDATE holds
        SET status = 'expired'
      WHERE status = 'active'
        AND expires_at <= now()`,
  );

  return rows;
}

/**
 * Sweep expired holds in their own transaction and broadcast releases.
 * Used by the periodic timer and can be called ad-hoc.
 */
export async function sweepExpiredHolds() {
  const db = getDb();
  let released = [];
  await db.transaction(async (tx) => {
    released = await releaseExpiredSeats(tx);
  });
  if (released.length > 0) {
    broadcastSeatUpdates(released.map(toPublicSeat));
  }
  return released.length;
}

/**
 * Return the full seat map with effective statuses. Releases expired holds
 * first (and broadcasts those releases) so reads are always exact.
 */
export async function getSeatMap() {
  await sweepExpiredHolds();
  const db = getDb();
  const { rows } = await db.query(
    `SELECT ${PUBLIC_SEAT_COLUMNS} FROM seats ORDER BY row_label, seat_number`,
  );
  return rows.map(toPublicSeat);
}

/**
 * Compute exact inventory counts. available + held(active) + booked == total.
 */
export async function getInventory() {
  await sweepExpiredHolds();
  const db = getDb();
  const { rows } = await db.query(
    `SELECT ${PUBLIC_SEAT_COLUMNS} FROM seats`,
  );
  const counts = { available: 0, held: 0, booked: 0, total: rows.length };
  for (const seat of rows) {
    counts[effectiveStatus(seat)] += 1;
  }
  return counts;
}

export class BookingError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Atomically acquire ALL requested seats for a session, or none. On success
 * creates a hold and marks the seats held with an expiry. Throws BookingError
 * with 409 + conflicting seat ids if any seat is unavailable.
 *
 * @param {string[]} seatIds
 * @param {string} sessionId
 */
export async function createHold(seatIds, sessionId) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    throw new BookingError(400, 'invalid_request', 'seatIds must be a non-empty array');
  }
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new BookingError(400, 'invalid_request', 'sessionId is required');
  }

  // De-duplicate requested seats.
  const uniqueSeatIds = [...new Set(seatIds)];

  const db = getDb();
  const holdId = randomUUID();
  let released = [];
  let heldSeats = [];
  let holdRow = null;

  await db.transaction(async (tx) => {
    // Step 1: enforce expiry first so freshly-expired seats are acquirable.
    released = await releaseExpiredSeats(tx);

    // Step 2: lock the requested seats and read their current state.
    // FOR UPDATE serializes concurrent requests touching the same seats.
    const placeholders = uniqueSeatIds.map((_, i) => `$${i + 1}`).join(', ');
    const { rows: requested } = await tx.query(
      `SELECT ${PUBLIC_SEAT_COLUMNS}
         FROM seats
        WHERE id IN (${placeholders})
        ORDER BY id
        FOR UPDATE`,
      uniqueSeatIds,
    );

    // Validate that every requested seat exists.
    const foundIds = new Set(requested.map((s) => s.id));
    const missing = uniqueSeatIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new BookingError(404, 'seat_not_found', 'Some seats do not exist', {
        missing,
      });
    }

    // Step 3: all-or-nothing availability check using effective status.
    const conflicts = requested
      .filter((s) => effectiveStatus(s) !== 'available')
      .map((s) => s.id);
    if (conflicts.length > 0) {
      throw new BookingError(
        409,
        'seats_unavailable',
        'One or more requested seats are no longer available',
        { conflicts },
      );
    }

    // Step 4: create the hold and mark seats held atomically.
    const { rows: holdRows } = await tx.query(
      `INSERT INTO holds (id, session_id, expires_at)
       VALUES ($1, $2, now() + ($3::int * interval '1 millisecond'))
       RETURNING id, session_id, created_at, expires_at, status`,
      [holdId, sessionId, HOLD_TTL_MS],
    );
    holdRow = holdRows[0];

    // Renumber the IN-clause placeholders to start at $3 since $1/$2 are
    // reused for the hold id and expiry below.
    const updatePlaceholders = uniqueSeatIds
      .map((_, i) => `$${i + 3}`)
      .join(', ');
    const { rows: updated } = await tx.query(
      `UPDATE seats
          SET status = 'held',
              hold_id = $1,
              hold_expires_at = $2,
              booked_by = NULL
        WHERE id IN (${updatePlaceholders})
        RETURNING ${PUBLIC_SEAT_COLUMNS}`,
      [holdId, holdRow.expires_at, ...uniqueSeatIds],
    );
    heldSeats = updated;
  });

  // Broadcast releases (from expiry) then the new holds.
  const updates = [...released, ...heldSeats].map(toPublicSeat);
  broadcastSeatUpdates(updates);

  return {
    holdId: holdRow.id,
    sessionId: holdRow.session_id,
    status: holdRow.status,
    expiresAt: holdRow.expires_at,
    seatIds: heldSeats.map((s) => s.id),
    seats: heldSeats.map(toPublicSeat),
  };
}

/**
 * Confirm a hold: book its seats permanently. Idempotent — a second confirm of
 * the same hold returns the same booking and books nothing additional.
 * Expired or unknown holds fail and book nothing.
 *
 * @param {string} holdId
 * @param {string} [sessionId] - optional ownership check
 */
export async function confirmHold(holdId, sessionId) {
  if (typeof holdId !== 'string' || holdId.trim() === '') {
    throw new BookingError(400, 'invalid_request', 'holdId is required');
  }

  const db = getDb();
  let released = [];
  let bookedSeats = [];
  let result = null;

  await db.transaction(async (tx) => {
    released = await releaseExpiredSeats(tx);

    // Lock the hold row.
    const { rows: holdRows } = await tx.query(
      `SELECT id, session_id, created_at, expires_at, status
         FROM holds
        WHERE id = $1
        FOR UPDATE`,
      [holdId],
    );

    if (holdRows.length === 0) {
      throw new BookingError(404, 'hold_not_found', 'Hold does not exist');
    }
    const hold = holdRows[0];

    if (sessionId && hold.session_id !== sessionId) {
      throw new BookingError(403, 'not_owner', 'Hold belongs to another session');
    }

    // Idempotent path: already confirmed -> return existing booking.
    if (hold.status === 'confirmed') {
      const { rows: seats } = await tx.query(
        `SELECT ${PUBLIC_SEAT_COLUMNS}
           FROM seats
          WHERE hold_id = $1 AND status = 'booked'
          ORDER BY id`,
        [holdId],
      );
      result = {
        holdId: hold.id,
        sessionId: hold.session_id,
        status: 'confirmed',
        idempotent: true,
        seatIds: seats.map((s) => s.id),
        seats: seats.map(toPublicSeat),
      };
      return;
    }

    if (hold.status !== 'active') {
      throw new BookingError(
        410,
        'hold_expired',
        `Hold is ${hold.status} and can no longer be confirmed`,
      );
    }

    // Re-validate expiry inside the transaction.
    if (new Date(hold.expires_at).getTime() <= Date.now()) {
      // Release its seats (releaseExpiredSeats may have already done so, but be
      // defensive in case of clock granularity).
      await tx.query(
        `UPDATE seats
            SET status = 'available', hold_id = NULL, hold_expires_at = NULL
          WHERE hold_id = $1 AND status = 'held'`,
        [holdId],
      );
      await tx.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [holdId]);
      throw new BookingError(410, 'hold_expired', 'Hold has expired; nothing booked');
    }

    // Lock the seats this hold owns and book them.
    const { rows: ownedSeats } = await tx.query(
      `SELECT ${PUBLIC_SEAT_COLUMNS}
         FROM seats
        WHERE hold_id = $1 AND status = 'held'
        ORDER BY id
        FOR UPDATE`,
      [holdId],
    );

    if (ownedSeats.length === 0) {
      throw new BookingError(
        409,
        'no_seats',
        'Hold owns no held seats; nothing to confirm',
      );
    }

    const { rows: booked } = await tx.query(
      `UPDATE seats
          SET status = 'booked',
              booked_by = $2,
              hold_expires_at = NULL
        WHERE hold_id = $1 AND status = 'held'
        RETURNING ${PUBLIC_SEAT_COLUMNS}`,
      [holdId, hold.session_id],
    );
    bookedSeats = booked;

    await tx.query(`UPDATE holds SET status = 'confirmed' WHERE id = $1`, [holdId]);

    result = {
      holdId: hold.id,
      sessionId: hold.session_id,
      status: 'confirmed',
      idempotent: false,
      seatIds: booked.map((s) => s.id),
      seats: booked.map(toPublicSeat),
    };
  });

  const updates = [...released, ...bookedSeats].map(toPublicSeat);
  broadcastSeatUpdates(updates);

  return result;
}

/**
 * Release a hold early, returning its seats to available. Idempotent: releasing
 * an already-released/expired hold succeeds and frees nothing extra. Confirmed
 * holds cannot be released.
 *
 * @param {string} holdId
 * @param {string} [sessionId]
 */
export async function releaseHold(holdId, sessionId) {
  if (typeof holdId !== 'string' || holdId.trim() === '') {
    throw new BookingError(400, 'invalid_request', 'holdId is required');
  }

  const db = getDb();
  let released = [];
  let freedSeats = [];
  let result = null;

  await db.transaction(async (tx) => {
    released = await releaseExpiredSeats(tx);

    const { rows: holdRows } = await tx.query(
      `SELECT id, session_id, status FROM holds WHERE id = $1 FOR UPDATE`,
      [holdId],
    );

    if (holdRows.length === 0) {
      throw new BookingError(404, 'hold_not_found', 'Hold does not exist');
    }
    const hold = holdRows[0];

    if (sessionId && hold.session_id !== sessionId) {
      throw new BookingError(403, 'not_owner', 'Hold belongs to another session');
    }

    if (hold.status === 'confirmed') {
      throw new BookingError(
        409,
        'already_confirmed',
        'Confirmed holds cannot be released',
      );
    }

    if (hold.status === 'active') {
      const { rows: freed } = await tx.query(
        `UPDATE seats
            SET status = 'available', hold_id = NULL, hold_expires_at = NULL
          WHERE hold_id = $1 AND status = 'held'
          RETURNING ${PUBLIC_SEAT_COLUMNS}`,
        [holdId],
      );
      freedSeats = freed;
      await tx.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);
    }

    result = {
      holdId: hold.id,
      status: 'released',
      seatIds: freedSeats.map((s) => s.id),
    };
  });

  const updates = [...released, ...freedSeats].map(toPublicSeat);
  broadcastSeatUpdates(updates);

  return result;
}

/**
 * Fetch a hold's current state (for clients reconnecting / polling TTL).
 */
export async function getHold(holdId) {
  await sweepExpiredHolds();
  const db = getDb();
  const { rows } = await db.query(
    `SELECT id, session_id, created_at, expires_at, status FROM holds WHERE id = $1`,
    [holdId],
  );
  if (rows.length === 0) {
    throw new BookingError(404, 'hold_not_found', 'Hold does not exist');
  }
  const hold = rows[0];
  const { rows: seats } = await db.query(
    `SELECT ${PUBLIC_SEAT_COLUMNS} FROM seats WHERE hold_id = $1 ORDER BY id`,
    [holdId],
  );
  return {
    holdId: hold.id,
    sessionId: hold.session_id,
    status: hold.status,
    expiresAt: hold.expires_at,
    seatIds: seats.map((s) => s.id),
    seats: seats.map(toPublicSeat),
  };
}
