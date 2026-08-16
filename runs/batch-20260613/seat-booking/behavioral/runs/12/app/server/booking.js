import { randomUUID } from 'node:crypto';
import { HOLD_TTL_MS } from './config.js';

/**
 * Error type carrying an HTTP status and optional structured detail.
 */
export class BookingError extends Error {
  constructor(message, status = 400, detail = undefined) {
    super(message);
    this.name = 'BookingError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * BookingService owns all seat mutations. Every write operation runs through a
 * single-slot async mutex so that, regardless of how many concurrent HTTP
 * requests arrive, seat acquisition is fully serialised and therefore atomic:
 * two requests can never both win the same seat.
 *
 * Each mutating operation returns `{ ...result, changed: [...seats] }` where
 * `changed` is the list of seat snapshots whose status transitioned, so the
 * caller can broadcast them over SSE.
 */
export class BookingService {
  /**
   * @param {import('@electric-sql/pglite').PGlite} db
   * @param {object} [opts]
   * @param {number} [opts.ttlMs]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.ttlMs = opts.ttlMs ?? HOLD_TTL_MS;
    /** @type {Promise<any>} tail of the serialisation chain */
    this._chain = Promise.resolve();
  }

  /**
   * Serialise an async function against all other writes.
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  _withLock(fn) {
    const run = this._chain.then(fn, fn);
    // Keep the chain alive even if `fn` rejects, but don't swallow the result.
    this._chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  // ----- Expiry --------------------------------------------------------------

  /**
   * Release any holds whose expires_at has passed. Returns the seat snapshots
   * that transitioned back to available. Must be called inside a tx OR will
   * create its own. Intended to run *before* every read / write.
   *
   * @param {object} [tx] optional transaction handle
   * @returns {Promise<Array<object>>}
   */
  async _expireStaleHolds(tx = this.db) {
    // Mark expired holds.
    await tx.query(
      `UPDATE holds SET status = 'expired'
       WHERE status = 'active' AND expires_at <= now()`
    );

    // Release seats whose hold is no longer active (expired/released) but that
    // are still flagged as held. Return the affected seat rows.
    const { rows } = await tx.query(
      `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL
       WHERE status = 'held'
         AND (hold_expires_at IS NULL OR hold_expires_at <= now())
       RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`
    );
    return rows;
  }

  /**
   * Public entrypoint for the periodic sweep. Releases stale holds and returns
   * the changed seats so the server can broadcast them.
   */
  async sweepExpired() {
    return this._withLock(async () => {
      let released = [];
      await this.db.transaction(async (tx) => {
        released = await this._expireStaleHolds(tx);
      });
      return released;
    });
  }

  // ----- Reads ---------------------------------------------------------------

  /**
   * Return the full seat map with effective status. Expired holds are released
   * first so a stale "held" seat is reported as available.
   * @returns {Promise<{ seats: object[], released: object[], summary: object }>}
   */
  async getSeats() {
    return this._withLock(async () => {
      let released = [];
      let seats = [];
      await this.db.transaction(async (tx) => {
        released = await this._expireStaleHolds(tx);
        const res = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
             FROM seats
            ORDER BY row_label, seat_number`
        );
        seats = res.rows;
      });
      return { seats, released, summary: summarise(seats) };
    });
  }

  // ----- Holds ---------------------------------------------------------------

  /**
   * Atomically acquire ALL requested seats for a session. All-or-nothing: if
   * any requested seat is not currently available, none are acquired and a 409
   * BookingError is thrown carrying the conflicting seat ids.
   *
   * @param {string[]} seatIds
   * @param {string} sessionId
   * @returns {Promise<{ hold: object, seats: object[], changed: object[] }>}
   */
  async createHold(seatIds, sessionId) {
    if (!Array.isArray(seatIds) || seatIds.length === 0) {
      throw new BookingError('seatIds must be a non-empty array', 400);
    }
    if (!sessionId || typeof sessionId !== 'string') {
      throw new BookingError('sessionId is required', 400);
    }
    const uniqueIds = [...new Set(seatIds)];

    return this._withLock(async () => {
      let result;
      let released = [];
      await this.db.transaction(async (tx) => {
        released = await this._expireStaleHolds(tx);

        // Validate the requested ids exist.
        const existing = await tx.query(
          `SELECT id, status FROM seats WHERE id = ANY($1::text[])`,
          [uniqueIds]
        );
        if (existing.rows.length !== uniqueIds.length) {
          const found = new Set(existing.rows.map((r) => r.id));
          const missing = uniqueIds.filter((id) => !found.has(id));
          throw new BookingError(`Unknown seat ids: ${missing.join(', ')}`, 404, {
            unknownSeatIds: missing,
          });
        }

        // Which requested seats are NOT available right now? -> conflict.
        const conflicting = existing.rows
          .filter((r) => r.status !== 'available')
          .map((r) => r.id);
        if (conflicting.length > 0) {
          // Throwing rolls back the tx: nothing is acquired.
          throw new BookingError('One or more seats are no longer available', 409, {
            conflictingSeatIds: conflicting,
          });
        }

        const holdId = randomUUID();
        const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();

        await tx.query(
          `INSERT INTO holds (id, session_id, status, expires_at)
           VALUES ($1, $2, 'active', $3)`,
          [holdId, sessionId, expiresAt]
        );

        // Conditional update: only flip seats that are *still* available.
        const upd = await tx.query(
          `UPDATE seats
              SET status = 'held', hold_id = $2, hold_expires_at = $3
            WHERE id = ANY($1::text[]) AND status = 'available'
          RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
          [uniqueIds, holdId, expiresAt]
        );

        // Defensive: if anything changed under us, abort (rolls back).
        if (upd.rows.length !== uniqueIds.length) {
          const heldNow = new Set(upd.rows.map((r) => r.id));
          const conflict = uniqueIds.filter((id) => !heldNow.has(id));
          throw new BookingError('One or more seats are no longer available', 409, {
            conflictingSeatIds: conflict,
          });
        }

        const holdRow = (
          await tx.query(`SELECT * FROM holds WHERE id = $1`, [holdId])
        ).rows[0];

        result = { hold: holdRow, seats: upd.rows, changed: upd.rows };
      });

      // Merge any expiry-released seats into changed set for broadcasting.
      result._released = released;
      return result;
    });
  }

  // ----- Confirm -------------------------------------------------------------

  /**
   * Confirm a hold: book all seats it owns. Idempotent: a second confirm of the
   * same hold returns the same booking and books nothing additional. Expired or
   * unknown holds are rejected and book nothing.
   *
   * @param {string} holdId
   * @param {string} [sessionId] optional ownership check
   * @returns {Promise<{ hold: object, seats: object[], changed: object[], alreadyConfirmed: boolean }>}
   */
  async confirmHold(holdId, sessionId) {
    if (!holdId) throw new BookingError('holdId is required', 400);

    return this._withLock(async () => {
      let result;
      let released = [];
      await this.db.transaction(async (tx) => {
        released = await this._expireStaleHolds(tx);

        const hold = (
          await tx.query(`SELECT * FROM holds WHERE id = $1`, [holdId])
        ).rows[0];

        if (!hold) {
          throw new BookingError('Unknown hold', 404, { holdId });
        }
        if (sessionId && hold.session_id !== sessionId) {
          throw new BookingError('Hold belongs to a different session', 403, { holdId });
        }

        // Idempotency: already confirmed -> return its booked seats, change nothing.
        if (hold.status === 'confirmed') {
          const seats = (
            await tx.query(
              `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
                 FROM seats WHERE hold_id = $1 ORDER BY row_label, seat_number`,
              [holdId]
            )
          ).rows;
          result = { hold, seats, changed: [], alreadyConfirmed: true };
          return;
        }

        // Any non-active (expired/released) hold cannot be confirmed.
        if (hold.status !== 'active') {
          throw new BookingError(`Hold is ${hold.status}; cannot confirm`, 409, {
            holdId,
            status: hold.status,
          });
        }

        // Re-validate expiry inside the transaction.
        if (new Date(hold.expires_at).getTime() <= Date.now()) {
          await tx.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [holdId]);
          // _expireStaleHolds above should already have released the seats; do it
          // again to be safe for this specific hold.
          const rel = await tx.query(
            `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL
              WHERE hold_id = $1 AND status = 'held'
            RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
            [holdId]
          );
          released = released.concat(rel.rows);
          throw new BookingError('Hold has expired', 409, { holdId });
        }

        // Book exactly the seats this hold still owns and that are held.
        const booked = await tx.query(
          `UPDATE seats
              SET status = 'booked', booked_by = $2, hold_expires_at = NULL
            WHERE hold_id = $1 AND status = 'held'
          RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
          [holdId, hold.session_id]
        );

        if (booked.rows.length === 0) {
          // No held seats owned by this hold -> nothing to book. This means the
          // seats were released out from under the hold. Treat as failure.
          throw new BookingError('Hold owns no held seats; nothing to confirm', 409, {
            holdId,
          });
        }

        await tx.query(
          `UPDATE holds SET status = 'confirmed', confirmed_at = now() WHERE id = $1`,
          [holdId]
        );

        const updatedHold = (
          await tx.query(`SELECT * FROM holds WHERE id = $1`, [holdId])
        ).rows[0];

        result = {
          hold: updatedHold,
          seats: booked.rows,
          changed: booked.rows,
          alreadyConfirmed: false,
        };
      });

      result._released = released;
      return result;
    });
  }

  // ----- Release -------------------------------------------------------------

  /**
   * Release a hold early, returning its seats to available. Idempotent for
   * already-released/expired holds. Confirmed holds cannot be released.
   *
   * @param {string} holdId
   * @param {string} [sessionId]
   * @returns {Promise<{ hold: object, seats: object[], changed: object[] }>}
   */
  async releaseHold(holdId, sessionId) {
    if (!holdId) throw new BookingError('holdId is required', 400);

    return this._withLock(async () => {
      let result;
      let released = [];
      await this.db.transaction(async (tx) => {
        released = await this._expireStaleHolds(tx);

        const hold = (
          await tx.query(`SELECT * FROM holds WHERE id = $1`, [holdId])
        ).rows[0];

        if (!hold) {
          throw new BookingError('Unknown hold', 404, { holdId });
        }
        if (sessionId && hold.session_id !== sessionId) {
          throw new BookingError('Hold belongs to a different session', 403, { holdId });
        }
        if (hold.status === 'confirmed') {
          throw new BookingError('Confirmed holds cannot be released', 409, { holdId });
        }

        const rel = await tx.query(
          `UPDATE seats
              SET status = 'available', hold_id = NULL, hold_expires_at = NULL
            WHERE hold_id = $1 AND status = 'held'
          RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
          [holdId]
        );

        await tx.query(
          `UPDATE holds SET status = 'released' WHERE id = $1 AND status = 'active'`,
          [holdId]
        );

        const updatedHold = (
          await tx.query(`SELECT * FROM holds WHERE id = $1`, [holdId])
        ).rows[0];

        result = { hold: updatedHold, seats: rel.rows, changed: rel.rows };
      });

      result._released = released;
      return result;
    });
  }
}

/**
 * Compute effective inventory counts. Held counts only *active* holds; since
 * expiry is enforced before reads, any seat still flagged 'held' is active.
 */
export function summarise(seats) {
  const summary = { total: seats.length, available: 0, held: 0, booked: 0 };
  for (const s of seats) {
    if (s.status === 'available') summary.available++;
    else if (s.status === 'held') summary.held++;
    else if (s.status === 'booked') summary.booked++;
  }
  return summary;
}
