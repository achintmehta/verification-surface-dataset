import { randomUUID } from 'node:crypto';

/**
 * SeatStore encapsulates all seat/hold/confirm/expiry logic on top of a PGlite
 * database instance. All mutations run inside SERIALIZABLE-style transactions
 * so that concurrent hold requests for the same seat cannot both succeed.
 *
 * Concurrency model:
 *   PGlite executes queries one at a time (single connection), and we serialize
 *   all write operations through an internal promise chain (`this.chain`). Within
 *   a transaction we additionally perform atomic conditional UPDATEs that only
 *   affect seats which are *effectively* available, so the all-or-nothing
 *   semantics are guaranteed even if serialization were relaxed.
 */
export class SeatStore {
  /**
   * @param {import('@electric-sql/pglite').PGlite} db
   * @param {object} [opts]
   * @param {number} [opts.holdTtlMs] - Hold time-to-live in milliseconds.
   * @param {(events:Array)=>void} [opts.onBroadcast] - Called with seat-change events.
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.holdTtlMs = opts.holdTtlMs ?? 2 * 60 * 1000; // default 2 minutes
    this.onBroadcast = opts.onBroadcast ?? (() => {});
    this.chain = Promise.resolve();
  }

  /** Serialize a unit of work so writes never interleave. */
  _serial(fn) {
    const run = this.chain.then(fn, fn);
    // Swallow rejection on the chain so one failure doesn't poison the queue.
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  _broadcast(events) {
    if (events && events.length) {
      try {
        this.onBroadcast(events);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  /**
   * Release (inside a transaction) any held seats whose hold has expired.
   * Returns the list of seat-change events produced.
   */
  async _expireWithin(tx, nowIso) {
    const { rows } = await tx.query(
      `UPDATE seats
          SET status = 'available', hold_id = NULL, hold_expires_at = NULL, booked_by = NULL
        WHERE status = 'held'
          AND hold_expires_at IS NOT NULL
          AND hold_expires_at <= $1
        RETURNING id`,
      [nowIso]
    );
    return rows.map((r) => ({ type: 'released', seatId: r.id, status: 'available' }));
  }

  /**
   * Return every seat with its effective status. Expired holds are reported as
   * available; we also actively release them and broadcast.
   */
  async getSeats() {
    return this._serial(async () => {
      const nowIso = new Date().toISOString();
      let events = [];
      await this.db.transaction(async (tx) => {
        events = await this._expireWithin(tx, nowIso);
      });
      this._broadcast(events);

      const { rows } = await this.db.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
           FROM seats
          ORDER BY row_label, seat_number`
      );
      return rows.map((r) => ({
        id: r.id,
        row: r.row_label,
        number: r.seat_number,
        status: r.status,
        holdId: r.hold_id,
        holdExpiresAt: r.hold_expires_at,
        bookedBy: r.booked_by,
      }));
    });
  }

  /** Inventory summary; useful for tests and sanity checks. */
  async summary() {
    return this._serial(async () => {
      const nowIso = new Date().toISOString();
      await this.db.transaction(async (tx) => {
        await this._expireWithin(tx, nowIso);
      });
      const { rows } = await this.db.query(
        `SELECT status, COUNT(*)::int AS c FROM seats GROUP BY status`
      );
      const out = { available: 0, held: 0, booked: 0, total: 0 };
      for (const r of rows) {
        out[r.status] = r.c;
        out.total += r.c;
      }
      return out;
    });
  }

  /**
   * Atomically acquire ALL requested seats only if every one is currently
   * available (after expiry). All-or-nothing: on any conflict, no seat changes.
   *
   * @param {string[]} seatIds
   * @param {string} sessionId
   * @returns {Promise<{ok:true, hold:object} | {ok:false, status:number, error:string, conflicts?:string[]}>}
   */
  async createHold(seatIds, sessionId) {
    if (!Array.isArray(seatIds) || seatIds.length === 0) {
      return { ok: false, status: 400, error: 'seatIds must be a non-empty array' };
    }
    if (!sessionId || typeof sessionId !== 'string') {
      return { ok: false, status: 400, error: 'sessionId is required' };
    }
    // De-duplicate requested seat ids.
    const requested = [...new Set(seatIds)];

    return this._serial(async () => {
      const now = new Date();
      const nowIso = now.toISOString();
      const expiresAt = new Date(now.getTime() + this.holdTtlMs);
      const expiresIso = expiresAt.toISOString();
      const holdId = randomUUID();

      let result;
      let releaseEvents = [];
      let acquired = [];

      await this.db.transaction(async (tx) => {
        // 1. Expire stale holds first so freshly-freed seats are acquirable.
        releaseEvents = await this._expireWithin(tx, nowIso);

        // 2. Validate that every requested seat id exists.
        const { rows: existing } = await tx.query(
          `SELECT id, status, hold_expires_at
             FROM seats
            WHERE id = ANY($1::text[])`,
          [requested]
        );
        const existingIds = new Set(existing.map((r) => r.id));
        const unknown = requested.filter((id) => !existingIds.has(id));
        if (unknown.length > 0) {
          result = {
            ok: false,
            status: 404,
            error: 'Unknown seat id(s)',
            conflicts: unknown,
          };
          throw new Rollback();
        }

        // 3. Atomic conditional acquire: only flip seats that are effectively
        //    available (available, OR held-but-expired). Count must equal N.
        const { rows: updated } = await tx.query(
          `UPDATE seats
              SET status = 'held', hold_id = $2, hold_expires_at = $3, booked_by = $5
            WHERE id = ANY($1::text[])
              AND (
                    status = 'available'
                 OR (status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at <= $4)
              )
            RETURNING id`,
          [requested, holdId, expiresIso, nowIso, sessionId]
        );
        acquired = updated.map((r) => r.id);

        if (acquired.length !== requested.length) {
          // Conflict: some seats not acquirable. Find which ones.
          const acquiredSet = new Set(acquired);
          const conflicts = requested.filter((id) => !acquiredSet.has(id));
          result = {
            ok: false,
            status: 409,
            error: 'One or more seats are no longer available',
            conflicts,
          };
          // Throwing rolls back the partial UPDATE -> all-or-nothing.
          throw new Rollback();
        }

        result = {
          ok: true,
          hold: {
            holdId,
            sessionId,
            seatIds: acquired,
            expiresAt: expiresIso,
            ttlMs: this.holdTtlMs,
          },
        };
      }).catch((e) => {
        if (!(e instanceof Rollback)) throw e;
      });

      // Broadcast releases (from expiry) regardless of hold outcome.
      this._broadcast(releaseEvents);

      if (result.ok) {
        const heldEvents = acquired.map((id) => ({
          type: 'held',
          seatId: id,
          status: 'held',
          holdId,
          holdExpiresAt: expiresIso,
        }));
        this._broadcast(heldEvents);
      }

      return result;
    });
  }

  /**
   * Confirm a hold: verify it exists, is not expired, and still owns its seats,
   * then mark them booked. Idempotent — confirming an already-booked hold
   * returns the same booking and books nothing additional.
   *
   * @param {string} holdId
   * @returns {Promise<{ok:true, booking:object} | {ok:false, status:number, error:string}>}
   */
  async confirmHold(holdId) {
    if (!holdId || typeof holdId !== 'string') {
      return { ok: false, status: 400, error: 'holdId is required' };
    }

    return this._serial(async () => {
      const now = new Date();
      const nowIso = now.toISOString();

      let result;
      let releaseEvents = [];
      let bookedIds = [];

      await this.db.transaction(async (tx) => {
        // Idempotency: if this hold already produced bookings, return them.
        const { rows: alreadyBooked } = await tx.query(
          `SELECT id FROM seats WHERE status = 'booked' AND hold_id = $1 ORDER BY id`,
          [holdId]
        );
        if (alreadyBooked.length > 0) {
          result = {
            ok: true,
            booking: {
              holdId,
              seatIds: alreadyBooked.map((r) => r.id),
              alreadyConfirmed: true,
            },
          };
          return; // commit (no changes)
        }

        // Expire stale holds (do NOT expire the hold we may be confirming yet;
        // we check its own expiry explicitly below).
        releaseEvents = await this._expireWithin(tx, nowIso);

        // Find the seats currently held by this hold and not yet expired.
        const { rows: held } = await tx.query(
          `SELECT id, hold_expires_at
             FROM seats
            WHERE status = 'held' AND hold_id = $1`,
          [holdId]
        );

        if (held.length === 0) {
          result = {
            ok: false,
            status: 404,
            error: 'Hold not found, expired, or already released',
          };
          return;
        }

        // Verify none of the hold's seats are expired.
        const expired = held.some(
          (r) => r.hold_expires_at && new Date(r.hold_expires_at) <= now
        );
        if (expired) {
          result = {
            ok: false,
            status: 410,
            error: 'Hold has expired',
          };
          return;
        }

        // Book all seats of this hold atomically.
        const { rows: bookedRows } = await tx.query(
          `UPDATE seats
              SET status = 'booked',
                  hold_expires_at = NULL
            WHERE status = 'held'
              AND hold_id = $1
              AND (hold_expires_at IS NULL OR hold_expires_at > $2)
            RETURNING id`,
          [holdId, nowIso]
        );
        bookedIds = bookedRows.map((r) => r.id).sort();

        if (bookedIds.length !== held.length) {
          // Should not happen, but be safe: roll back.
          result = { ok: false, status: 409, error: 'Could not book all held seats' };
          throw new Rollback();
        }

        result = {
          ok: true,
          booking: { holdId, seatIds: bookedIds, alreadyConfirmed: false },
        };
      }).catch((e) => {
        if (!(e instanceof Rollback)) throw e;
      });

      this._broadcast(releaseEvents);
      if (result.ok && !result.booking.alreadyConfirmed) {
        this._broadcast(
          bookedIds.map((id) => ({ type: 'booked', seatId: id, status: 'booked', holdId }))
        );
      }
      return result;
    });
  }

  /**
   * Release a hold early, returning its seats to available.
   * @param {string} holdId
   */
  async releaseHold(holdId) {
    if (!holdId || typeof holdId !== 'string') {
      return { ok: false, status: 400, error: 'holdId is required' };
    }
    return this._serial(async () => {
      let released = [];
      await this.db.transaction(async (tx) => {
        const { rows } = await tx.query(
          `UPDATE seats
              SET status = 'available', hold_id = NULL, hold_expires_at = NULL, booked_by = NULL
            WHERE status = 'held' AND hold_id = $1
            RETURNING id`,
          [holdId]
        );
        released = rows.map((r) => r.id);
      });

      if (released.length === 0) {
        return { ok: false, status: 404, error: 'No active hold to release' };
      }
      this._broadcast(
        released.map((id) => ({ type: 'released', seatId: id, status: 'available' }))
      );
      return { ok: true, released };
    });
  }

  /**
   * Periodic sweep: release any expired holds and broadcast.
   * @returns {Promise<string[]>} released seat ids
   */
  async sweep() {
    return this._serial(async () => {
      const nowIso = new Date().toISOString();
      let events = [];
      await this.db.transaction(async (tx) => {
        events = await this._expireWithin(tx, nowIso);
      });
      this._broadcast(events);
      return events.map((e) => e.seatId);
    });
  }
}

/** Internal sentinel error used to roll back a transaction intentionally. */
class Rollback extends Error {}
