import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { config } from './config.js';

// ---------------------------------------------------------------------------
// Serialisation
//
// PGlite is a single embedded connection. To guarantee correctness under
// concurrency we serialise every *mutating* seat operation through a promise
// queue. Combined with all-or-nothing conditional SQL, this makes it
// impossible for two requests to acquire or book the same seat.
// ---------------------------------------------------------------------------
let opChain = Promise.resolve();

function withLock(fn) {
  const run = opChain.then(fn, fn);
  // Keep the chain alive regardless of success/failure, but don't leak the
  // rejection into the chain's own state.
  opChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function now() {
  return Date.now();
}

// ---------------------------------------------------------------------------
// Effective status helpers
//
// A seat that is 'held' with an expired hold is *effectively* available. We
// surface this in reads and enforce it before every mutation.
// ---------------------------------------------------------------------------
function effectiveSeat(row) {
  const ts = now();
  let status = row.status;
  if (status === 'held' && row.hold_expires_at != null && Number(row.hold_expires_at) <= ts) {
    status = 'available';
  }
  return {
    id: row.id,
    row: row.row_label,
    number: row.seat_number,
    status,
    holdId: status === 'held' ? row.hold_id : null,
    holdExpiresAt: status === 'held' && row.hold_expires_at != null ? Number(row.hold_expires_at) : null,
    bookedBy: status === 'booked' ? row.booked_by : null,
  };
}

// Release every hold that has expired. Returns the effective seat rows that
// changed so callers can broadcast. Must be called inside the lock.
async function releaseExpired(db) {
  const ts = now();
  const { rows } = await db.query(
    `UPDATE seats
       SET status='available', hold_id=NULL, hold_expires_at=NULL
     WHERE status='held'
       AND hold_expires_at IS NOT NULL
       AND hold_expires_at <= $1
     RETURNING *`,
    [ts]
  );
  return rows.map(effectiveSeat);
}

// ---------------------------------------------------------------------------
// Public read API
// ---------------------------------------------------------------------------

// Returns { seats, released } where `released` lists seats freed by expiry as
// part of this read (so the caller can broadcast).
export async function listSeats() {
  return withLock(async () => {
    const db = getDb();
    const released = await releaseExpired(db);
    const { rows } = await db.query(
      'SELECT * FROM seats ORDER BY row_label, seat_number'
    );
    return { seats: rows.map(effectiveSeat), released };
  });
}

export async function inventory() {
  return withLock(async () => {
    const db = getDb();
    const released = await releaseExpired(db);
    const { rows } = await db.query('SELECT * FROM seats');
    const counts = { available: 0, held: 0, booked: 0, total: rows.length };
    for (const r of rows) {
      counts[effectiveSeat(r).status]++;
    }
    return { counts, released };
  });
}

// ---------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------

export class SeatError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// Atomically acquire ALL requested seats only if every one is currently
// available (after expiry). All-or-nothing: on any conflict, acquire none.
//
// Returns { hold, seats, released }.
export async function createHold(seatIds, sessionId) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    throw new SeatError(400, 'invalid_request', 'seatIds must be a non-empty array');
  }
  if (!sessionId || typeof sessionId !== 'string') {
    throw new SeatError(400, 'invalid_request', 'sessionId is required');
  }

  // Normalise and dedupe seat ids.
  const ids = [...new Set(seatIds.map(Number))];
  if (ids.some((n) => !Number.isInteger(n))) {
    throw new SeatError(400, 'invalid_request', 'seatIds must be integers');
  }

  return withLock(async () => {
    const db = getDb();
    const released = await releaseExpired(db);

    await db.query('BEGIN');
    try {
      // Read the requested seats with their *effective* status.
      const { rows } = await db.query(
        `SELECT * FROM seats WHERE id = ANY($1::int[])`,
        [ids]
      );

      const found = new Set(rows.map((r) => r.id));
      const missing = ids.filter((id) => !found.has(id));
      if (missing.length > 0) {
        await db.query('ROLLBACK');
        throw new SeatError(404, 'unknown_seats', 'Some seats do not exist', {
          unknownSeatIds: missing,
        });
      }

      // Determine conflicts using effective status.
      const conflicts = rows
        .filter((r) => effectiveSeat(r).status !== 'available')
        .map((r) => r.id);

      if (conflicts.length > 0) {
        await db.query('ROLLBACK');
        throw new SeatError(409, 'seats_unavailable', 'One or more seats are unavailable', {
          conflictSeatIds: conflicts.sort((a, b) => a - b),
        });
      }

      const holdId = randomUUID();
      const expiresAt = now() + config.holdTtlMs;

      // Conditional update: only flip seats that are still acquirable. The
      // condition re-checks availability (including expiry) at write time, so
      // even if logic above raced, the SQL guards correctness.
      const { rows: updated } = await db.query(
        `UPDATE seats
           SET status='held', hold_id=$1, hold_expires_at=$2, booked_by=NULL
         WHERE id = ANY($3::int[])
           AND (
             status='available'
             OR (status='held' AND hold_expires_at IS NOT NULL AND hold_expires_at <= $4)
           )
         RETURNING *`,
        [holdId, expiresAt, ids, now()]
      );

      if (updated.length !== ids.length) {
        // A seat slipped away between read and write — abort entirely.
        await db.query('ROLLBACK');
        const updatedIds = new Set(updated.map((r) => r.id));
        const lost = ids.filter((id) => !updatedIds.has(id));
        throw new SeatError(409, 'seats_unavailable', 'One or more seats are unavailable', {
          conflictSeatIds: lost.sort((a, b) => a - b),
        });
      }

      // Record the hold owner. We store the session id on the seats via a
      // companion column would be ideal, but we keep it in a holds table for
      // clean ownership tracking.
      await db.query(
        `INSERT INTO holds (hold_id, session_id, expires_at) VALUES ($1, $2, $3)`,
        [holdId, sessionId, expiresAt]
      );

      await db.query('COMMIT');

      const seats = updated.map(effectiveSeat);
      return {
        hold: {
          holdId,
          sessionId,
          expiresAt,
          ttlMs: config.holdTtlMs,
          seatIds: ids,
        },
        seats,
        released,
      };
    } catch (err) {
      // Ensure no dangling transaction.
      try {
        await db.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  });
}

// Release a hold early. Returns { released, seats } or throws if unknown.
export async function releaseHold(holdId, sessionId) {
  return withLock(async () => {
    const db = getDb();
    const expired = await releaseExpired(db);

    await db.query('BEGIN');
    try {
      const { rows: holdRows } = await db.query(
        `SELECT * FROM holds WHERE hold_id=$1`,
        [holdId]
      );

      if (holdRows.length === 0) {
        await db.query('ROLLBACK');
        // It may already have been expired+swept; treat as no-op success.
        return { seats: [], released: expired, alreadyGone: true };
      }

      const hold = holdRows[0];
      if (sessionId && hold.session_id !== sessionId) {
        await db.query('ROLLBACK');
        throw new SeatError(403, 'not_owner', 'Hold belongs to another session');
      }

      const { rows: freed } = await db.query(
        `UPDATE seats
           SET status='available', hold_id=NULL, hold_expires_at=NULL
         WHERE hold_id=$1 AND status='held'
         RETURNING *`,
        [holdId]
      );

      await db.query(`DELETE FROM holds WHERE hold_id=$1`, [holdId]);
      await db.query('COMMIT');

      return { seats: freed.map(effectiveSeat), released: expired };
    } catch (err) {
      try {
        await db.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  });
}

// Confirm a hold: book its seats permanently. Idempotent — confirming the same
// hold again returns the same booking without booking anything additional.
// Returns { booking, seats, released }.
export async function confirmHold(holdId, sessionId) {
  return withLock(async () => {
    const db = getDb();
    const expired = await releaseExpired(db);

    await db.query('BEGIN');
    try {
      const { rows: holdRows } = await db.query(
        `SELECT * FROM holds WHERE hold_id=$1`,
        [holdId]
      );

      if (holdRows.length === 0) {
        await db.query('ROLLBACK');
        // Could be a previously-confirmed (and removed) hold, or unknown.
        // Distinguish via the bookings table for idempotency.
        const { rows: bookingRows } = await db.query(
          `SELECT * FROM bookings WHERE hold_id=$1`,
          [holdId]
        );
        if (bookingRows.length > 0) {
          const booking = bookingRows[0];
          const { rows: seatRows } = await db.query(
            `SELECT * FROM seats WHERE id = ANY($1::int[]) ORDER BY row_label, seat_number`,
            [booking.seat_ids]
          );
          return {
            booking: {
              holdId,
              bookingId: booking.booking_id,
              sessionId: booking.session_id,
              seatIds: booking.seat_ids,
            },
            seats: seatRows.map(effectiveSeat),
            released: expired,
            idempotent: true,
          };
        }
        throw new SeatError(404, 'unknown_hold', 'Hold does not exist or has expired');
      }

      const hold = holdRows[0];

      // Re-validate expiry inside the transaction.
      if (Number(hold.expires_at) <= now()) {
        // Expired: free the seats (if still held by this hold) and remove it.
        const { rows: freed } = await db.query(
          `UPDATE seats
             SET status='available', hold_id=NULL, hold_expires_at=NULL
           WHERE hold_id=$1 AND status='held'
           RETURNING *`,
          [holdId]
        );
        await db.query(`DELETE FROM holds WHERE hold_id=$1`, [holdId]);
        await db.query('COMMIT');
        const releasedSeats = [...expired, ...freed.map(effectiveSeat)];
        throw new SeatError(410, 'hold_expired', 'Hold has expired', {
          released: releasedSeats,
        });
      }

      if (sessionId && hold.session_id !== sessionId) {
        await db.query('ROLLBACK');
        throw new SeatError(403, 'not_owner', 'Hold belongs to another session');
      }

      // Idempotency: if this hold was already booked, return that booking.
      const { rows: existingBooking } = await db.query(
        `SELECT * FROM bookings WHERE hold_id=$1`,
        [holdId]
      );
      if (existingBooking.length > 0) {
        const booking = existingBooking[0];
        const { rows: seatRows } = await db.query(
          `SELECT * FROM seats WHERE id = ANY($1::int[]) ORDER BY row_label, seat_number`,
          [booking.seat_ids]
        );
        await db.query('COMMIT');
        return {
          booking: {
            holdId,
            bookingId: booking.booking_id,
            sessionId: booking.session_id,
            seatIds: booking.seat_ids,
          },
          seats: seatRows.map(effectiveSeat),
          released: expired,
          idempotent: true,
        };
      }

      // Book the seats that this hold currently owns.
      const { rows: booked } = await db.query(
        `UPDATE seats
           SET status='booked', booked_by=$2, hold_id=NULL, hold_expires_at=NULL
         WHERE hold_id=$1 AND status='held'
         RETURNING *`,
        [holdId, hold.session_id]
      );

      if (booked.length === 0) {
        // Hold exists but owns no held seats — inconsistent / already swept.
        await db.query(`DELETE FROM holds WHERE hold_id=$1`, [holdId]);
        await db.query('COMMIT');
        throw new SeatError(409, 'no_seats_to_book', 'Hold owns no held seats');
      }

      const bookingId = randomUUID();
      const seatIds = booked.map((r) => r.id).sort((a, b) => a - b);

      await db.query(
        `INSERT INTO bookings (booking_id, hold_id, session_id, seat_ids)
         VALUES ($1, $2, $3, $4)`,
        [bookingId, holdId, hold.session_id, seatIds]
      );
      await db.query(`DELETE FROM holds WHERE hold_id=$1`, [holdId]);

      await db.query('COMMIT');

      return {
        booking: {
          holdId,
          bookingId,
          sessionId: hold.session_id,
          seatIds,
        },
        seats: booked.map(effectiveSeat),
        released: expired,
        idempotent: false,
      };
    } catch (err) {
      try {
        await db.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  });
}

// Background sweep: release expired holds. Returns released effective seats.
export async function sweepExpired() {
  return withLock(async () => {
    const db = getDb();
    const released = await releaseExpired(db);
    if (released.length > 0) {
      // Drop the expired hold records too.
      await db.query(
        `DELETE FROM holds WHERE expires_at <= $1 AND hold_id NOT IN (SELECT hold_id FROM seats WHERE hold_id IS NOT NULL)`,
        [now()]
      );
    }
    return released;
  });
}
