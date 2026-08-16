// Core seat-booking logic built on top of a PGLite-compatible database.
//
// The database object passed in must expose:
//   - db.query(sql, params) -> { rows }
//   - db.exec(sql)
//   - db.transaction(async (tx) => { ... })  where tx exposes query()
//
// All correctness-under-concurrency guarantees live here. The HTTP layer is a
// thin wrapper around these functions.

import { randomUUID } from 'node:crypto';
import { ROWS, SEATS_PER_ROW, HOLD_TTL_MS } from './config.js';

/**
 * Create the schema (idempotent) and seed the fixed seat map exactly once.
 */
export async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id              TEXT PRIMARY KEY,
      row_label       TEXT NOT NULL,
      seat_number     INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'available'
                        CHECK (status IN ('available', 'held', 'booked')),
      hold_id         TEXT,
      hold_expires_at BIGINT,
      booked_by       TEXT
    );

    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      created_at  BIGINT NOT NULL,
      expires_at  BIGINT NOT NULL,
      -- status is 'active' while the hold reserves seats, 'confirmed' once the
      -- seats are booked, 'released' once cancelled/expired.
      status      TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'confirmed', 'released'))
    );

    CREATE TABLE IF NOT EXISTS hold_seats (
      hold_id TEXT NOT NULL,
      seat_id TEXT NOT NULL,
      PRIMARY KEY (hold_id, seat_id)
    );
  `);

  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  if (Number(rows[0].count) === 0) {
    // Seed deterministically inside a transaction.
    await db.transaction(async (tx) => {
      for (const row of ROWS) {
        for (let n = 1; n <= SEATS_PER_ROW; n++) {
          const id = `${row}${n}`;
          await tx.query(
            `INSERT INTO seats (id, row_label, seat_number, status)
             VALUES ($1, $2, $3, 'available')`,
            [id, row, n]
          );
        }
      }
    });
  }
}

/**
 * Map a raw seat row to its effective status. A held seat whose hold has
 * expired is reported as available (lazy expiry on read).
 */
function effectiveStatus(seat, now) {
  if (
    seat.status === 'held' &&
    seat.hold_expires_at != null &&
    Number(seat.hold_expires_at) <= now
  ) {
    return 'available';
  }
  return seat.status;
}

/**
 * Release every expired hold inside an existing transaction context.
 * Returns the list of seat ids that transitioned back to available.
 */
async function releaseExpiredWithin(tx, now) {
  // Find held seats whose hold has expired.
  const { rows: expired } = await tx.query(
    `SELECT id FROM seats
      WHERE status = 'held'
        AND hold_expires_at IS NOT NULL
        AND hold_expires_at <= $1`,
    [now]
  );

  if (expired.length > 0) {
    await tx.query(
      `UPDATE seats
          SET status = 'available', hold_id = NULL, hold_expires_at = NULL
        WHERE status = 'held'
          AND hold_expires_at IS NOT NULL
          AND hold_expires_at <= $1`,
      [now]
    );
  }

  // Mark the holds themselves as released.
  await tx.query(
    `UPDATE holds
        SET status = 'released'
      WHERE status = 'active' AND expires_at <= $1`,
    [now]
  );

  return expired.map((r) => r.id);
}

/**
 * Sweep expired holds in their own transaction. Returns released seat ids.
 */
export async function sweepExpired(db, now = Date.now()) {
  let released = [];
  await db.transaction(async (tx) => {
    released = await releaseExpiredWithin(tx, now);
  });
  return released;
}

/**
 * Read the full seat map with effective statuses. Performs a lazy expiry sweep
 * first so that the returned data and the persisted data agree.
 * Returns { seats, released } where released is the list of seat ids freed.
 */
export async function getSeats(db, now = Date.now()) {
  const released = await sweepExpired(db, now);

  const { rows } = await db.query(
    `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
       FROM seats
      ORDER BY row_label, seat_number`
  );

  const seats = rows.map((s) => ({
    id: s.id,
    row: s.row_label,
    number: s.seat_number,
    status: effectiveStatus(s, now),
    holdId: effectiveStatus(s, now) === 'held' ? s.hold_id : null,
    holdExpiresAt:
      effectiveStatus(s, now) === 'held' && s.hold_expires_at != null
        ? Number(s.hold_expires_at)
        : null,
    bookedBy: s.status === 'booked' ? s.booked_by : null,
  }));

  return { seats, released };
}

export class ConflictError extends Error {
  constructor(conflicts) {
    super('One or more seats are unavailable');
    this.name = 'ConflictError';
    this.conflicts = conflicts;
  }
}

export class HoldError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HoldError';
  }
}

/**
 * Atomically acquire ALL requested seats for a session. All-or-nothing:
 * if any requested seat is unavailable, none are acquired and a ConflictError
 * is thrown carrying the conflicting seat ids.
 *
 * Returns { hold, released } where released are seats freed by lazy expiry.
 */
export async function createHold(db, seatIds, sessionId, now = Date.now()) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    throw new HoldError('seatIds must be a non-empty array');
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new HoldError('sessionId is required');
  }

  // Deduplicate while preserving order.
  const requested = [...new Set(seatIds)];

  const holdId = randomUUID();
  const expiresAt = now + HOLD_TTL_MS;
  let released = [];

  await db.transaction(async (tx) => {
    // 1. Lazily release expired holds so freed seats can be acquired here.
    released = await releaseExpiredWithin(tx, now);

    // 2. Lock & read the requested seats. Ordering the ids gives a consistent
    //    lock-acquisition order and FOR UPDATE serializes concurrent attempts.
    const ordered = [...requested].sort();
    const placeholders = ordered.map((_, i) => `$${i + 1}`).join(', ');
    const { rows: seatRows } = await tx.query(
      `SELECT id, status, hold_expires_at
         FROM seats
        WHERE id IN (${placeholders})
        ORDER BY id
        FOR UPDATE`,
      ordered
    );

    // 3. Validate every requested seat exists.
    const found = new Set(seatRows.map((r) => r.id));
    const missing = requested.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new ConflictError(missing);
    }

    // 4. Compute effective availability. A seat is acquirable if it is
    //    available, or held by an already-expired hold.
    const conflicts = [];
    for (const seat of seatRows) {
      const eff = effectiveStatus(seat, now);
      if (eff !== 'available') {
        conflicts.push(seat.id);
      }
    }
    if (conflicts.length > 0) {
      // All-or-nothing: abort the transaction, acquiring nothing.
      throw new ConflictError(conflicts.sort());
    }

    // 5. Acquire all seats. The WHERE clause re-asserts availability as a
    //    final guard against any racing writer.
    const updPlaceholders = ordered.map((_, i) => `$${i + 3}`).join(', ');
    const { rows: reallyUpdated } = await tx.query(
      `UPDATE seats
          SET status = 'held', hold_id = $1, hold_expires_at = $2
        WHERE id IN (${updPlaceholders})
          AND status = 'available'
        RETURNING id`,
      [holdId, expiresAt, ...ordered]
    );

    if (reallyUpdated.length !== ordered.length) {
      // A concurrent writer beat us to one of the seats after our read.
      // Abort so nothing is acquired.
      const got = new Set(reallyUpdated.map((r) => r.id));
      const lost = ordered.filter((id) => !got.has(id));
      throw new ConflictError(lost.sort());
    }

    // 6. Record the hold.
    await tx.query(
      `INSERT INTO holds (id, session_id, created_at, expires_at, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [holdId, sessionId, now, expiresAt]
    );
    for (const seatId of requested) {
      await tx.query(
        `INSERT INTO hold_seats (hold_id, seat_id) VALUES ($1, $2)`,
        [holdId, seatId]
      );
    }
  });

  const hold = {
    id: holdId,
    sessionId,
    seatIds: requested,
    createdAt: now,
    expiresAt,
    status: 'active',
  };

  return { hold, released };
}

/**
 * Confirm a hold, booking its seats permanently. Idempotent: a second confirm
 * of the same hold returns the same booking and books nothing additional.
 * Throws HoldError if the hold is unknown, expired, or released.
 *
 * Returns { booking, released }.
 */
export async function confirmHold(db, holdId, now = Date.now()) {
  let result;
  let released = [];

  await db.transaction(async (tx) => {
    released = await releaseExpiredWithin(tx, now);

    const { rows: holdRows } = await tx.query(
      `SELECT id, session_id, created_at, expires_at, status
         FROM holds
        WHERE id = $1
        FOR UPDATE`,
      [holdId]
    );

    if (holdRows.length === 0) {
      throw new HoldError('Unknown hold');
    }
    const hold = holdRows[0];

    const { rows: seatLinks } = await tx.query(
      `SELECT seat_id FROM hold_seats WHERE hold_id = $1 ORDER BY seat_id`,
      [holdId]
    );
    const seatIds = seatLinks.map((r) => r.seat_id);

    // Idempotency: already confirmed -> return the existing booking.
    if (hold.status === 'confirmed') {
      result = {
        holdId,
        sessionId: hold.session_id,
        seatIds,
        status: 'confirmed',
      };
      return;
    }

    if (hold.status === 'released') {
      throw new HoldError('Hold has been released');
    }

    // status === 'active': enforce expiry.
    if (Number(hold.expires_at) <= now) {
      // Release it (the releaseExpiredWithin above may already have, but the
      // FOR UPDATE row could still read 'active' if expiry == now boundary).
      await tx.query(
        `UPDATE seats
            SET status = 'available', hold_id = NULL, hold_expires_at = NULL
          WHERE hold_id = $1 AND status = 'held'`,
        [holdId]
      );
      await tx.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [
        holdId,
      ]);
      throw new HoldError('Hold has expired');
    }

    // Re-validate ownership: every seat must still be held by this hold.
    const placeholders = seatIds.map((_, i) => `$${i + 2}`).join(', ');
    const { rows: seatRows } = await tx.query(
      `SELECT id, status, hold_id
         FROM seats
        WHERE id IN (${placeholders})
        FOR UPDATE`,
      [holdId, ...seatIds]
    );

    for (const seat of seatRows) {
      if (seat.status !== 'held' || seat.hold_id !== holdId) {
        // Should not happen for an active, non-expired hold, but guard anyway.
        throw new HoldError('Hold no longer owns its seats');
      }
    }

    // Book the seats.
    await tx.query(
      `UPDATE seats
          SET status = 'booked', booked_by = $1, hold_id = NULL, hold_expires_at = NULL
        WHERE id IN (${placeholders}) AND hold_id = $1`,
      [holdId, ...seatIds]
    );
    await tx.query(`UPDATE holds SET status = 'confirmed' WHERE id = $1`, [
      holdId,
    ]);

    result = {
      holdId,
      sessionId: hold.session_id,
      seatIds,
      status: 'confirmed',
    };
  });

  return { booking: result, released };
}

/**
 * Release a hold early, returning its seats to available.
 * Throws HoldError for unknown holds. Idempotent for already-released holds.
 * Confirmed holds cannot be released.
 *
 * Returns { released } where released is the list of freed seat ids.
 */
export async function releaseHold(db, holdId, now = Date.now()) {
  let releasedSeats = [];

  await db.transaction(async (tx) => {
    const { rows: holdRows } = await tx.query(
      `SELECT id, status FROM holds WHERE id = $1 FOR UPDATE`,
      [holdId]
    );
    if (holdRows.length === 0) {
      throw new HoldError('Unknown hold');
    }
    const hold = holdRows[0];

    if (hold.status === 'confirmed') {
      throw new HoldError('Cannot release a confirmed hold');
    }
    if (hold.status === 'released') {
      releasedSeats = [];
      return;
    }

    const { rows: freed } = await tx.query(
      `UPDATE seats
          SET status = 'available', hold_id = NULL, hold_expires_at = NULL
        WHERE hold_id = $1 AND status = 'held'
        RETURNING id`,
      [holdId]
    );
    releasedSeats = freed.map((r) => r.id);

    await tx.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [
      holdId,
    ]);
  });

  return { released: releasedSeats };
}

/**
 * Fetch the effective status of a set of seat ids (no sweep). Useful for
 * building broadcast payloads after a mutation.
 */
export async function getSeatStates(db, seatIds, now = Date.now()) {
  if (!seatIds || seatIds.length === 0) return [];
  const ids = [...new Set(seatIds)];
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await db.query(
    `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
       FROM seats
      WHERE id IN (${placeholders})`,
    ids
  );
  return rows.map((s) => ({
    id: s.id,
    row: s.row_label,
    number: s.seat_number,
    status: effectiveStatus(s, now),
    holdId: effectiveStatus(s, now) === 'held' ? s.hold_id : null,
    holdExpiresAt:
      effectiveStatus(s, now) === 'held' && s.hold_expires_at != null
        ? Number(s.hold_expires_at)
        : null,
    bookedBy: s.status === 'booked' ? s.booked_by : null,
  }));
}

/**
 * Inventory accounting helper: returns counts that must always reconcile.
 */
export async function getInventory(db, now = Date.now()) {
  await sweepExpired(db, now);
  const { rows } = await db.query(
    `SELECT
        SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END)::int AS available,
        SUM(CASE WHEN status = 'held' THEN 1 ELSE 0 END)::int AS held,
        SUM(CASE WHEN status = 'booked' THEN 1 ELSE 0 END)::int AS booked,
        COUNT(*)::int AS total
       FROM seats`
  );
  const r = rows[0];
  return {
    available: Number(r.available) || 0,
    held: Number(r.held) || 0,
    booked: Number(r.booked) || 0,
    total: Number(r.total) || 0,
  };
}
