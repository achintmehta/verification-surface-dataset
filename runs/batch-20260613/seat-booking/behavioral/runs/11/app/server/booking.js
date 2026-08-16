import { HOLD_TTL_MS } from './config.js';

/**
 * BookingService encapsulates all transactional seat logic against a PGLite db.
 *
 * Concurrency model:
 *  PGLite executes queries serially on a single connection, so we rely on
 *  explicit transactions plus all-or-nothing conditional UPDATEs to guarantee
 *  that two requests can never both acquire the same seat. Every mutating
 *  operation first expires stale holds (lazy expiry), so inventory always
 *  reconciles to reality.
 *
 * Events: pass an `onChange` callback to receive arrays of seat-status
 * transitions ({ seatId, status, ... }) suitable for SSE broadcast.
 */
export class BookingService {
  /**
   * @param {import('@electric-sql/pglite').PGlite} db
   * @param {(changes: Array<object>) => void} [onChange]
   * @param {() => number} [now] - injectable clock (ms) for tests
   */
  constructor(db, onChange = () => {}, now = () => Date.now()) {
    this.db = db;
    this.onChange = onChange;
    this.now = now;
    // Serialize all mutating operations so that "expire + acquire" runs as one
    // logical critical section even though callers may invoke concurrently.
    this._queue = Promise.resolve();
  }

  /** Run `fn` exclusively with respect to other queued mutations. */
  _serial(fn) {
    const run = this._queue.then(fn, fn);
    // Keep the chain alive but swallow errors so one failure doesn't poison it.
    this._queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  _nowIso() {
    return new Date(this.now()).toISOString();
  }

  /**
   * Release any holds whose expires_at is in the past. Returns the list of
   * seat changes (seats reverted to available). Must be called inside the
   * serial queue (callers below already are).
   */
  async _expireStaleHolds() {
    const nowIso = this._nowIso();
    const { rows } = await this.db.query(
      `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL
       WHERE status = 'held' AND hold_expires_at <= $1
       RETURNING id, row_label, seat_number;`,
      [nowIso],
    );

    await this.db.query(
      `UPDATE holds SET status = 'released'
       WHERE status = 'active' AND expires_at <= $1;`,
      [nowIso],
    );

    return rows.map((r) => ({
      seatId: r.id,
      status: 'available',
      row_label: r.row_label,
      seat_number: r.seat_number,
      reason: 'expired',
    }));
  }

  /** Lazy-expire stale holds and broadcast releases. Public sweep entry point. */
  async sweep() {
    return this._serial(async () => {
      const changes = await this._expireStaleHolds();
      if (changes.length) this.onChange(changes);
      return changes;
    });
  }

  /**
   * Return all seats with their effective status. Held seats whose hold has
   * expired are reported (and persisted) as available.
   */
  async getSeats() {
    return this._serial(async () => {
      const changes = await this._expireStaleHolds();
      if (changes.length) this.onChange(changes);

      const { rows } = await this.db.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
           FROM seats
          ORDER BY row_label, seat_number;`,
      );
      return rows.map(normalizeSeat);
    });
  }

  /** Inventory summary: { available, held, booked, total }. */
  async getInventory() {
    return this._serial(async () => {
      await this._expireStaleHolds();
      const { rows } = await this.db.query(
        `SELECT status, COUNT(*)::int AS count FROM seats GROUP BY status;`,
      );
      const inv = { available: 0, held: 0, booked: 0, total: 0 };
      for (const r of rows) {
        inv[r.status] = r.count;
        inv.total += r.count;
      }
      return inv;
    });
  }

  /**
   * Atomically place a hold on ALL requested seats. All-or-nothing: if any
   * seat is unavailable, none are acquired and a conflict error is returned.
   *
   * @param {string[]} seatIds
   * @param {string} sessionId
   * @returns {Promise<{ ok: true, hold: object } | { ok: false, status: number, error: string, conflicts?: string[] }>}
   */
  async hold(seatIds, sessionId) {
    return this._serial(async () => {
      // Validate input
      if (!Array.isArray(seatIds) || seatIds.length === 0) {
        return { ok: false, status: 400, error: 'seatIds must be a non-empty array' };
      }
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return { ok: false, status: 400, error: 'sessionId is required' };
      }
      const unique = [...new Set(seatIds)];

      const expiredChanges = await this._expireStaleHolds();

      try {
        await this.db.query('BEGIN;');

        // Verify every requested seat exists and is available.
        const { rows: current } = await this.db.query(
          `SELECT id, status, hold_expires_at FROM seats WHERE id = ANY($1);`,
          [unique],
        );
        const found = new Map(current.map((r) => [r.id, r]));

        const missing = unique.filter((id) => !found.has(id));
        if (missing.length) {
          await this.db.query('ROLLBACK;');
          if (expiredChanges.length) this.onChange(expiredChanges);
          return {
            ok: false,
            status: 404,
            error: 'unknown seat ids',
            conflicts: missing,
          };
        }

        const conflicts = unique.filter((id) => found.get(id).status !== 'available');
        if (conflicts.length) {
          await this.db.query('ROLLBACK;');
          if (expiredChanges.length) this.onChange(expiredChanges);
          return {
            ok: false,
            status: 409,
            error: 'one or more seats are not available',
            conflicts,
          };
        }

        // Create the hold.
        const holdId = randomId('hold');
        const nowMs = this.now();
        const expiresAt = new Date(nowMs + HOLD_TTL_MS).toISOString();
        await this.db.query(
          `INSERT INTO holds (id, session_id, expires_at, status)
           VALUES ($1, $2, $3, 'active');`,
          [holdId, sessionId, expiresAt],
        );

        // Conditional, all-or-nothing acquisition: only updates rows that are
        // STILL available. If the affected count != requested count, abort.
        const { rows: updated } = await this.db.query(
          `UPDATE seats
              SET status = 'held', hold_id = $1, hold_expires_at = $2
            WHERE id = ANY($3) AND status = 'available'
            RETURNING id, row_label, seat_number;`,
          [holdId, expiresAt, unique],
        );

        if (updated.length !== unique.length) {
          // Lost a race: another in-flight op took a seat. Acquire none.
          await this.db.query('ROLLBACK;');
          if (expiredChanges.length) this.onChange(expiredChanges);
          const acquiredIds = new Set(updated.map((r) => r.id));
          return {
            ok: false,
            status: 409,
            error: 'one or more seats are not available',
            conflicts: unique.filter((id) => !acquiredIds.has(id)),
          };
        }

        await this.db.query('COMMIT;');

        const changes = [
          ...expiredChanges,
          ...updated.map((r) => ({
            seatId: r.id,
            status: 'held',
            row_label: r.row_label,
            seat_number: r.seat_number,
            hold_id: holdId,
            hold_expires_at: expiresAt,
          })),
        ];
        this.onChange(changes);

        return {
          ok: true,
          hold: {
            id: holdId,
            sessionId,
            seatIds: unique,
            expiresAt,
            ttlMs: HOLD_TTL_MS,
            status: 'active',
          },
        };
      } catch (err) {
        await this.db.query('ROLLBACK;').catch(() => {});
        throw err;
      }
    });
  }

  /**
   * Confirm a hold: book its seats permanently. Idempotent — a second confirm
   * of the same hold returns the same booking and books nothing additional.
   * Expired or unknown holds fail and book nothing.
   *
   * @param {string} holdId
   * @returns {Promise<{ ok: true, booking: object } | { ok: false, status: number, error: string }>}
   */
  async confirm(holdId) {
    return this._serial(async () => {
      if (typeof holdId !== 'string' || holdId.length === 0) {
        return { ok: false, status: 400, error: 'holdId is required' };
      }

      const expiredChanges = await this._expireStaleHolds();

      try {
        await this.db.query('BEGIN;');

        const { rows: holdRows } = await this.db.query(
          `SELECT id, session_id, expires_at, status FROM holds WHERE id = $1;`,
          [holdId],
        );
        if (holdRows.length === 0) {
          await this.db.query('ROLLBACK;');
          if (expiredChanges.length) this.onChange(expiredChanges);
          return { ok: false, status: 404, error: 'unknown hold' };
        }
        const hold = holdRows[0];

        // Idempotency: already confirmed → return existing booking, book nothing.
        if (hold.status === 'confirmed') {
          const { rows: booked } = await this.db.query(
            `SELECT id, row_label, seat_number, booked_by
               FROM seats WHERE hold_id = $1 AND status = 'booked'
              ORDER BY row_label, seat_number;`,
            [holdId],
          );
          await this.db.query('COMMIT;');
          if (expiredChanges.length) this.onChange(expiredChanges);
          return {
            ok: true,
            idempotent: true,
            booking: {
              holdId,
              sessionId: hold.session_id,
              seatIds: booked.map((r) => r.id),
              status: 'confirmed',
            },
          };
        }

        if (hold.status === 'released') {
          await this.db.query('ROLLBACK;');
          if (expiredChanges.length) this.onChange(expiredChanges);
          return { ok: false, status: 410, error: 'hold has expired or been released' };
        }

        // status === 'active': re-validate expiry inside the transaction.
        const nowIso = this._nowIso();
        if (new Date(hold.expires_at).getTime() <= this.now()) {
          // Expired between sweep and now (shouldn't happen given serial), but
          // be defensive: release and fail.
          await this.db.query(
            `UPDATE holds SET status = 'released' WHERE id = $1;`,
            [holdId],
          );
          const { rows: released } = await this.db.query(
            `UPDATE seats
                SET status = 'available', hold_id = NULL, hold_expires_at = NULL
              WHERE hold_id = $1 AND status = 'held'
              RETURNING id, row_label, seat_number;`,
            [holdId],
          );
          await this.db.query('COMMIT;');
          const changes = [
            ...expiredChanges,
            ...released.map((r) => ({
              seatId: r.id,
              status: 'available',
              row_label: r.row_label,
              seat_number: r.seat_number,
              reason: 'expired',
            })),
          ];
          if (changes.length) this.onChange(changes);
          return { ok: false, status: 410, error: 'hold has expired or been released' };
        }

        // Book the seats that this active, valid hold currently holds.
        const { rows: booked } = await this.db.query(
          `UPDATE seats
              SET status = 'booked', booked_by = $2, hold_expires_at = NULL
            WHERE hold_id = $1 AND status = 'held'
            RETURNING id, row_label, seat_number;`,
          [holdId, hold.session_id],
        );

        if (booked.length === 0) {
          // No held seats remain for this hold → nothing to book.
          await this.db.query('ROLLBACK;');
          if (expiredChanges.length) this.onChange(expiredChanges);
          return { ok: false, status: 410, error: 'hold has no held seats to confirm' };
        }

        await this.db.query(
          `UPDATE holds SET status = 'confirmed' WHERE id = $1;`,
          [holdId],
        );

        await this.db.query('COMMIT;');

        const changes = [
          ...expiredChanges,
          ...booked.map((r) => ({
            seatId: r.id,
            status: 'booked',
            row_label: r.row_label,
            seat_number: r.seat_number,
            booked_by: hold.session_id,
          })),
        ];
        this.onChange(changes);

        return {
          ok: true,
          booking: {
            holdId,
            sessionId: hold.session_id,
            seatIds: booked.map((r) => r.id),
            status: 'confirmed',
          },
        };
      } catch (err) {
        await this.db.query('ROLLBACK;').catch(() => {});
        throw err;
      }
    });
  }

  /**
   * Release an active hold early, returning its held seats to available.
   * No-op (still ok) if the hold doesn't exist or is already gone.
   *
   * @param {string} holdId
   * @param {string} [sessionId] - if provided, must match the hold's owner.
   */
  async release(holdId, sessionId) {
    return this._serial(async () => {
      if (typeof holdId !== 'string' || holdId.length === 0) {
        return { ok: false, status: 400, error: 'holdId is required' };
      }

      const expiredChanges = await this._expireStaleHolds();

      try {
        await this.db.query('BEGIN;');

        const { rows: holdRows } = await this.db.query(
          `SELECT id, session_id, status FROM holds WHERE id = $1;`,
          [holdId],
        );
        if (holdRows.length === 0) {
          await this.db.query('ROLLBACK;');
          if (expiredChanges.length) this.onChange(expiredChanges);
          return { ok: false, status: 404, error: 'unknown hold' };
        }
        const hold = holdRows[0];

        if (sessionId && hold.session_id !== sessionId) {
          await this.db.query('ROLLBACK;');
          if (expiredChanges.length) this.onChange(expiredChanges);
          return { ok: false, status: 403, error: 'hold belongs to another session' };
        }

        if (hold.status === 'confirmed') {
          await this.db.query('ROLLBACK;');
          if (expiredChanges.length) this.onChange(expiredChanges);
          return { ok: false, status: 409, error: 'hold is already confirmed' };
        }

        const { rows: released } = await this.db.query(
          `UPDATE seats
              SET status = 'available', hold_id = NULL, hold_expires_at = NULL
            WHERE hold_id = $1 AND status = 'held'
            RETURNING id, row_label, seat_number;`,
          [holdId],
        );
        await this.db.query(
          `UPDATE holds SET status = 'released' WHERE id = $1;`,
          [holdId],
        );

        await this.db.query('COMMIT;');

        const changes = [
          ...expiredChanges,
          ...released.map((r) => ({
            seatId: r.id,
            status: 'available',
            row_label: r.row_label,
            seat_number: r.seat_number,
            reason: 'released',
          })),
        ];
        if (changes.length) this.onChange(changes);

        return { ok: true, released: released.map((r) => r.id) };
      } catch (err) {
        await this.db.query('ROLLBACK;').catch(() => {});
        throw err;
      }
    });
  }
}

function normalizeSeat(r) {
  return {
    id: r.id,
    row_label: r.row_label,
    seat_number: r.seat_number,
    status: r.status,
    hold_id: r.hold_id || null,
    hold_expires_at: r.hold_expires_at
      ? new Date(r.hold_expires_at).toISOString()
      : null,
    booked_by: r.booked_by || null,
  };
}

let counter = 0;
function randomId(prefix) {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}
