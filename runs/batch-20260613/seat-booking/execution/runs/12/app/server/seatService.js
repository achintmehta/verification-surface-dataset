import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { config } from './config.js';

/**
 * The seat service encapsulates all transactional seat logic. It guarantees:
 *  - atomic all-or-nothing hold acquisition,
 *  - lazy expiry of stale holds on every read / mutation,
 *  - idempotent confirmation,
 *  - exact inventory accounting.
 *
 * A broadcaster callback (set via setBroadcaster) is invoked with the list of
 * seats whose effective status transitioned, so the HTTP layer can push SSE
 * events. We never broadcast from inside a transaction; instead each method
 * returns the changed seats and broadcasts after commit.
 */

let broadcast = () => {};
export function setBroadcaster(fn) {
  broadcast = fn;
}

// A simple in-process async mutex. PGLite runs a single embedded Postgres
// instance and we serialize write transactions through this lock so that
// concurrent hold requests for overlapping seats are evaluated one at a time.
// Correctness ultimately relies on the SQL conditional updates, but the lock
// removes any ambiguity around interleaved transactions in the embedded engine.
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn, fn);
  // Keep the chain alive regardless of success/failure, but don't leak rejections.
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function publicSeat(row) {
  return {
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: row.seat_number,
    status: row.status,
    holdId: row.hold_id,
    holdExpiresAt: row.hold_expires_at,
    bookedBy: row.booked_by,
  };
}

/**
 * Release every hold whose expires_at is in the past. Runs inside whatever
 * transaction the caller is in. Returns the rows of seats that were released.
 */
async function expireStaleHolds(db) {
  // Mark expired hold records.
  await db.query(
    `UPDATE holds SET status = 'expired'
       WHERE status = 'active' AND expires_at <= now()`
  );

  // Free seats whose hold has expired. Returns the affected seats.
  const { rows } = await db.query(
    `UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE status = 'held' AND hold_expires_at <= now()
      RETURNING *`
  );
  return rows;
}

/**
 * Read all seats with effective status. Expires stale holds first so a held
 * seat past its TTL is reported (and persisted) as available.
 */
export async function getSeats() {
  return withLock(async () => {
    const db = getDb();
    let released = [];
    await db.transaction(async (tx) => {
      released = await expireStaleHolds(tx);
    });
    if (released.length) broadcast(released.map(publicSeat));

    const { rows } = await getDb().query(
      'SELECT * FROM seats ORDER BY row_label, seat_number'
    );
    return rows.map(publicSeat);
  });
}

export async function getInventory() {
  const seats = await getSeats();
  const counts = { available: 0, held: 0, booked: 0, total: seats.length };
  for (const s of seats) counts[s.status]++;
  return counts;
}

/**
 * Atomically place a hold on ALL requested seats. All-or-nothing: if any
 * requested seat is not currently available (after expiry), nothing is held and
 * we return { ok: false, conflicts: [...] }.
 */
export async function createHold(seatIds, sessionId) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return { ok: false, error: 'seatIds must be a non-empty array', code: 400 };
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, error: 'sessionId is required', code: 400 };
  }
  // De-duplicate and validate ints.
  const ids = [...new Set(seatIds.map((n) => Number(n)))];
  if (ids.some((n) => !Number.isInteger(n))) {
    return { ok: false, error: 'seatIds must be integers', code: 400 };
  }

  return withLock(async () => {
    const db = getDb();
    let result;
    let released = [];
    let heldSeats = [];

    await db.transaction(async (tx) => {
      // 1. Expire stale holds first so previously-leaked seats are acquirable.
      released = await expireStaleHolds(tx);

      // 2. Determine which requested seats are NOT available.
      const { rows: conflictRows } = await tx.query(
        `SELECT id FROM seats
          WHERE id = ANY($1::int[]) AND status <> 'available'`,
        [ids]
      );

      // Also detect non-existent seat ids.
      const { rows: existingRows } = await tx.query(
        `SELECT id FROM seats WHERE id = ANY($1::int[])`,
        [ids]
      );
      const existing = new Set(existingRows.map((r) => r.id));
      const missing = ids.filter((id) => !existing.has(id));

      if (conflictRows.length > 0 || missing.length > 0) {
        const conflicts = [
          ...conflictRows.map((r) => r.id),
          ...missing,
        ];
        result = { ok: false, code: 409, conflicts, error: 'Some seats are unavailable' };
        return; // transaction commits the expiry releases, holds nothing
      }

      // 3. Acquire all seats atomically. The WHERE clause re-checks availability
      // so even within this serialized transaction we never overwrite a
      // non-available seat. We require the count of updated rows to equal ids.length.
      const holdId = randomUUID();
      const expiresAt = new Date(Date.now() + config.holdTtlMs).toISOString();

      const { rows: updated } = await tx.query(
        `UPDATE seats
            SET status = 'held', hold_id = $1, hold_expires_at = $2
          WHERE id = ANY($3::int[]) AND status = 'available'
          RETURNING *`,
        [holdId, expiresAt, ids]
      );

      if (updated.length !== ids.length) {
        // Should not happen given the checks above, but enforce all-or-nothing.
        throw new Error('ROLLBACK_PARTIAL_HOLD');
      }

      await tx.query(
        `INSERT INTO holds (id, session_id, expires_at, status)
         VALUES ($1, $2, $3, 'active')`,
        [holdId, sessionId, expiresAt]
      );

      heldSeats = updated;
      result = {
        ok: true,
        hold: {
          id: holdId,
          sessionId,
          expiresAt,
          ttlMs: config.holdTtlMs,
          seatIds: updated.map((r) => r.id),
        },
      };
    }).catch((err) => {
      if (err.message === 'ROLLBACK_PARTIAL_HOLD') {
        result = { ok: false, code: 409, conflicts: ids, error: 'Seats were taken concurrently' };
      } else {
        throw err;
      }
    });

    // Broadcast after commit.
    const changes = [...released.map(publicSeat), ...heldSeats.map(publicSeat)];
    if (changes.length) broadcast(changes);

    return result;
  });
}

/**
 * Confirm a hold: book its seats permanently. Idempotent — confirming a hold
 * already confirmed returns the same booking and books nothing new. An expired
 * or unknown hold fails and books nothing.
 */
export async function confirmHold(holdId, sessionId) {
  if (!holdId) return { ok: false, code: 400, error: 'holdId is required' };

  return withLock(async () => {
    const db = getDb();
    let result;
    let released = [];
    let bookedSeats = [];

    await db.transaction(async (tx) => {
      // Expire stale holds first (do not expire the one we're confirming unless truly past TTL).
      released = await expireStaleHolds(tx);

      const { rows: holdRows } = await tx.query(
        `SELECT * FROM holds WHERE id = $1`,
        [holdId]
      );
      const hold = holdRows[0];

      if (!hold) {
        result = { ok: false, code: 404, error: 'Hold not found' };
        return;
      }

      // Idempotency: already confirmed -> return its booked seats.
      if (hold.status === 'confirmed') {
        const { rows: seats } = await tx.query(
          `SELECT * FROM seats WHERE hold_id = $1 AND status = 'booked'`,
          [holdId]
        );
        result = {
          ok: true,
          alreadyConfirmed: true,
          booking: {
            holdId,
            sessionId: hold.session_id,
            seatIds: seats.map((s) => s.id),
          },
        };
        return;
      }

      if (hold.status === 'expired' || hold.status === 'released') {
        result = { ok: false, code: 410, error: `Hold is ${hold.status}` };
        return;
      }

      // hold.status === 'active' — re-validate expiry inside the transaction.
      const { rows: nowRows } = await tx.query(
        `SELECT (expires_at <= now()) AS expired FROM holds WHERE id = $1`,
        [holdId]
      );
      if (nowRows[0].expired) {
        // Mark expired and release its seats.
        await tx.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [holdId]);
        const { rows: freed } = await tx.query(
          `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL
             WHERE hold_id = $1 AND status = 'held' RETURNING *`,
          [holdId]
        );
        released = [...released, ...freed];
        result = { ok: false, code: 410, error: 'Hold has expired' };
        return;
      }

      // Optional ownership check: only the session that created the hold may confirm.
      if (sessionId && hold.session_id !== sessionId) {
        result = { ok: false, code: 403, error: 'Hold belongs to another session' };
        return;
      }

      // Book all seats this active hold still owns.
      const { rows: booked } = await tx.query(
        `UPDATE seats
            SET status = 'booked', booked_by = $2, hold_expires_at = NULL
          WHERE hold_id = $1 AND status = 'held'
          RETURNING *`,
        [holdId, hold.session_id]
      );

      if (booked.length === 0) {
        // Hold is active but owns no held seats (shouldn't normally happen).
        result = { ok: false, code: 409, error: 'Hold owns no seats to confirm' };
        return;
      }

      await tx.query(`UPDATE holds SET status = 'confirmed' WHERE id = $1`, [holdId]);

      bookedSeats = booked;
      result = {
        ok: true,
        booking: {
          holdId,
          sessionId: hold.session_id,
          seatIds: booked.map((s) => s.id),
        },
      };
    });

    const changes = [...released.map(publicSeat), ...bookedSeats.map(publicSeat)];
    if (changes.length) broadcast(changes);

    return result;
  });
}

/**
 * Release a hold early, returning its seats to available. Idempotent-ish:
 * releasing an unknown / already-released hold returns ok with no changes.
 * A confirmed hold cannot be released (its seats are booked).
 */
export async function releaseHold(holdId, sessionId) {
  if (!holdId) return { ok: false, code: 400, error: 'holdId is required' };

  return withLock(async () => {
    const db = getDb();
    let result;
    let freed = [];

    await db.transaction(async (tx) => {
      const { rows: holdRows } = await tx.query(`SELECT * FROM holds WHERE id = $1`, [holdId]);
      const hold = holdRows[0];

      if (!hold) {
        result = { ok: true, released: false, error: 'Hold not found' };
        return;
      }
      if (hold.status === 'confirmed') {
        result = { ok: false, code: 409, error: 'Hold already confirmed; seats are booked' };
        return;
      }
      if (sessionId && hold.session_id !== sessionId) {
        result = { ok: false, code: 403, error: 'Hold belongs to another session' };
        return;
      }

      const { rows } = await tx.query(
        `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL
           WHERE hold_id = $1 AND status = 'held' RETURNING *`,
        [holdId]
      );
      freed = rows;
      await tx.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);
      result = { ok: true, released: true, seatIds: rows.map((r) => r.id) };
    });

    if (freed.length) broadcast(freed.map(publicSeat));
    return result;
  });
}

/**
 * Background sweep: proactively expire stale holds even when nobody is reading.
 */
export async function sweepExpired() {
  return withLock(async () => {
    const db = getDb();
    let released = [];
    await db.transaction(async (tx) => {
      released = await expireStaleHolds(tx);
    });
    if (released.length) broadcast(released.map(publicSeat));
    return released.length;
  });
}
