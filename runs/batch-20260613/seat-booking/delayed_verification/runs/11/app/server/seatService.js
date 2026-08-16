import { randomUUID } from 'crypto';
import { getDb } from './db.js';
import { HOLD_TTL_MS } from './config.js';

/**
 * The seat service encapsulates all transactional seat logic.
 *
 * Concurrency model:
 *  - PGLite runs SQL serially on a single connection, but we still must guard
 *    against interleaving across awaits. We serialize every mutating operation
 *    through an in-process async mutex (operationQueue) AND wrap each operation
 *    in a SQL transaction. The combination guarantees that the atomic
 *    check-and-set for a hold cannot interleave with another hold/confirm.
 *  - Expiry is enforced lazily before every read and every mutation, and also
 *    by a periodic sweep.
 */

let broadcastFn = () => {};

export function setBroadcaster(fn) {
  broadcastFn = fn;
}

// ---- Simple promise-chain mutex to serialize mutating operations ----
let queue = Promise.resolve();
function withLock(task) {
  const run = queue.then(() => task());
  // Ensure the queue continues even if task rejects.
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Release any holds whose expires_at is in the past. Returns the list of seat
 * ids that transitioned back to available so callers can broadcast them.
 * Must be called inside a transaction (uses the same db handle).
 */
async function expireStaleHolds(db) {
  // Find seats currently held by an expired/non-active hold.
  const { rows: expiredSeats } = await db.query(
    `SELECT id FROM seats
       WHERE status = 'held'
         AND (hold_expires_at IS NULL OR hold_expires_at <= now())`
  );

  if (expiredSeats.length === 0) {
    // Still mark any active holds that are past expiry as released.
    await db.query(
      `UPDATE holds SET status = 'released'
         WHERE status = 'active' AND expires_at <= now()`
    );
    return [];
  }

  // Mark the corresponding holds released.
  await db.query(
    `UPDATE holds SET status = 'released'
       WHERE status = 'active' AND expires_at <= now()`
  );

  // Free the seats.
  await db.query(
    `UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE status = 'held'
        AND (hold_expires_at IS NULL OR hold_expires_at <= now())`
  );

  return expiredSeats.map((r) => r.id);
}

function seatPayload(row) {
  return {
    id: row.id,
    row: row.row_label,
    number: row.seat_number,
    status: row.status,
    holdId: row.hold_id || null,
    holdExpiresAt: row.hold_expires_at || null,
    bookedBy: row.booked_by || null,
  };
}

/**
 * Read all seats with effective status (expired holds reported as available).
 * Performs a lazy expiry sweep and broadcasts any releases it causes.
 */
export async function getSeats() {
  return withLock(async () => {
    const db = getDb();
    let released = [];
    await db.transaction(async (tx) => {
      released = await expireStaleHolds(tx);
    });
    if (released.length > 0) {
      const seats = await fetchSeatsByIds(released);
      broadcastFn({ type: 'released', seats });
    }
    const { rows } = await db.query(
      `SELECT * FROM seats ORDER BY row_label, seat_number`
    );
    return rows.map(seatPayload);
  });
}

async function fetchSeatsByIds(ids) {
  if (ids.length === 0) return [];
  const db = getDb();
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await db.query(
    `SELECT * FROM seats WHERE id IN (${placeholders})`,
    ids
  );
  return rows.map(seatPayload);
}

/**
 * Atomically place a hold on ALL requested seats (all-or-nothing).
 * Returns { ok: true, hold, seats } on success or
 * { ok: false, conflicts: [seatIds] } if any seat is unavailable.
 */
export async function createHold(seatIds, sessionId) {
  return withLock(async () => {
    const db = getDb();
    let result;
    let releasedToBroadcast = [];

    await db.transaction(async (tx) => {
      // Enforce expiry first so previously-expired seats become acquirable.
      // This is committed regardless of whether the hold itself succeeds, so
      // it is safe to broadcast afterwards.
      const released = await expireStaleHolds(tx);
      releasedToBroadcast = released;

      // Validate the requested seats exist.
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
      const { rows: existing } = await tx.query(
        `SELECT id, status FROM seats WHERE id IN (${placeholders})`,
        seatIds
      );
      const foundIds = new Set(existing.map((r) => r.id));
      const unknown = seatIds.filter((id) => !foundIds.has(id));

      // Conflicts: unknown seats OR seats not currently available.
      const taken = existing
        .filter((r) => r.status !== 'available')
        .map((r) => r.id);
      const conflicts = [...unknown, ...taken];

      if (conflicts.length > 0) {
        // Acquire none. The expiry releases above are still committed.
        result = { ok: false, conflicts };
        return;
      }

      // Acquire all seats atomically. The conditional WHERE status='available'
      // ensures we only acquire seats that are still free at write time. Since
      // mutations are serialized by the in-process lock and wrapped in a single
      // transaction, this update will acquire every requested seat whenever the
      // check above passed; the condition remains as a correctness safeguard.
      const holdId = randomUUID();
      const expiresAt = new Date(Date.now() + HOLD_TTL_MS).toISOString();

      const { rows: updated } = await tx.query(
        `UPDATE seats
            SET status = 'held', hold_id = $1, hold_expires_at = $2
          WHERE id IN (${seatIds.map((_, i) => `$${i + 3}`).join(', ')})
            AND status = 'available'
          RETURNING id`,
        [holdId, expiresAt, ...seatIds]
      );

      if (updated.length !== seatIds.length) {
        // Defensive: could not acquire all seats. Throw to roll back the
        // partial acquisition entirely (all-or-nothing).
        const acquired = new Set(updated.map((r) => r.id));
        const lost = seatIds.filter((id) => !acquired.has(id));
        const err = new Error('acquisition_failed');
        err.conflicts = lost;
        throw err;
      }

      await tx.query(
        `INSERT INTO holds (id, session_id, expires_at, status)
         VALUES ($1, $2, $3, 'active')`,
        [holdId, sessionId, expiresAt]
      );

      result = {
        ok: true,
        hold: { id: holdId, sessionId, expiresAt, seatIds: [...seatIds] },
      };
    }).catch((err) => {
      if (err && err.message === 'acquisition_failed') {
        // The whole transaction (including expiry releases) was rolled back.
        releasedToBroadcast = [];
        result = { ok: false, conflicts: err.conflicts || [...seatIds] };
        return;
      }
      throw err;
    });

    // Broadcast outside the transaction.
    if (releasedToBroadcast.length > 0) {
      broadcastFn({ type: 'released', seats: await fetchSeatsByIds(releasedToBroadcast) });
    }
    if (result.ok) {
      broadcastFn({ type: 'held', seats: await fetchSeatsByIds(result.hold.seatIds) });
    }
    return result;
  });
}

/**
 * Confirm a hold: book its seats. Idempotent.
 * Returns { ok: true, booking } or { ok: false, reason }.
 */
export async function confirmHold(holdId, sessionId) {
  return withLock(async () => {
    const db = getDb();
    let result;
    let releasedToBroadcast = [];

    await db.transaction(async (tx) => {
      const released = await expireStaleHolds(tx);
      releasedToBroadcast = released;

      const { rows: holdRows } = await tx.query(
        `SELECT * FROM holds WHERE id = $1`,
        [holdId]
      );

      if (holdRows.length === 0) {
        result = { ok: false, reason: 'unknown_hold' };
        return;
      }

      const hold = holdRows[0];

      // Optional ownership check: if sessionId provided, it must match.
      if (sessionId && hold.session_id !== sessionId) {
        result = { ok: false, reason: 'wrong_session' };
        return;
      }

      // Idempotency: already confirmed -> return the same booking.
      if (hold.status === 'confirmed') {
        const { rows: seatRows } = await tx.query(
          `SELECT * FROM seats WHERE hold_id = $1 AND status = 'booked'`,
          [holdId]
        );
        result = {
          ok: true,
          booking: {
            holdId,
            sessionId: hold.session_id,
            seatIds: seatRows.map((r) => r.id),
          },
          idempotent: true,
        };
        return;
      }

      // Re-validate expiry inside the transaction.
      const expired = new Date(hold.expires_at).getTime() <= Date.now();
      if (hold.status === 'released' || expired) {
        // Ensure status reflects release.
        if (hold.status === 'active') {
          await tx.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);
        }
        result = { ok: false, reason: 'expired' };
        return;
      }

      // Verify the hold still owns its seats (status 'held' & matching hold_id).
      const { rows: ownedSeats } = await tx.query(
        `SELECT id FROM seats
          WHERE hold_id = $1 AND status = 'held' AND hold_expires_at > now()`,
        [holdId]
      );

      if (ownedSeats.length === 0) {
        // Nothing to book; hold lost its seats.
        await tx.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);
        result = { ok: false, reason: 'no_seats' };
        return;
      }

      // Book the seats.
      await tx.query(
        `UPDATE seats
            SET status = 'booked',
                booked_by = $2,
                hold_expires_at = NULL
          WHERE hold_id = $1 AND status = 'held'`,
        [holdId, hold.session_id]
      );

      await tx.query(`UPDATE holds SET status = 'confirmed' WHERE id = $1`, [holdId]);

      result = {
        ok: true,
        booking: {
          holdId,
          sessionId: hold.session_id,
          seatIds: ownedSeats.map((r) => r.id),
        },
      };
    });

    if (releasedToBroadcast.length > 0) {
      broadcastFn({ type: 'released', seats: await fetchSeatsByIds(releasedToBroadcast) });
    }
    if (result.ok && !result.idempotent) {
      broadcastFn({ type: 'booked', seats: await fetchSeatsByIds(result.booking.seatIds) });
    }
    return result;
  });
}

/**
 * Release a hold early, returning its seats to available.
 * Returns { ok: true, seatIds } or { ok: false, reason }.
 */
export async function releaseHold(holdId, sessionId) {
  return withLock(async () => {
    const db = getDb();
    let result;
    let releasedSeats = [];

    await db.transaction(async (tx) => {
      const { rows: holdRows } = await tx.query(
        `SELECT * FROM holds WHERE id = $1`,
        [holdId]
      );
      if (holdRows.length === 0) {
        result = { ok: false, reason: 'unknown_hold' };
        return;
      }
      const hold = holdRows[0];

      if (sessionId && hold.session_id !== sessionId) {
        result = { ok: false, reason: 'wrong_session' };
        return;
      }

      if (hold.status === 'confirmed') {
        result = { ok: false, reason: 'already_confirmed' };
        return;
      }

      // Already released/expired -> idempotent no-op success.
      if (hold.status === 'released') {
        result = { ok: true, seatIds: [] };
        return;
      }

      const { rows: seatRows } = await tx.query(
        `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held'`,
        [holdId]
      );
      releasedSeats = seatRows.map((r) => r.id);

      await tx.query(
        `UPDATE seats
            SET status = 'available', hold_id = NULL, hold_expires_at = NULL
          WHERE hold_id = $1 AND status = 'held'`,
        [holdId]
      );
      await tx.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);

      result = { ok: true, seatIds: releasedSeats };
    });

    if (releasedSeats.length > 0) {
      broadcastFn({ type: 'released', seats: await fetchSeatsByIds(releasedSeats) });
    }
    return result;
  });
}

/**
 * Periodic sweep: release all stale holds and broadcast.
 */
export async function sweepExpired() {
  return withLock(async () => {
    const db = getDb();
    let released = [];
    await db.transaction(async (tx) => {
      released = await expireStaleHolds(tx);
    });
    if (released.length > 0) {
      broadcastFn({ type: 'released', seats: await fetchSeatsByIds(released) });
    }
    return released;
  });
}

/**
 * Inventory summary for diagnostics / acceptance checks.
 */
export async function getInventory() {
  await sweepExpired();
  const db = getDb();
  const { rows } = await db.query(
    `SELECT status, COUNT(*)::int AS count FROM seats GROUP BY status`
  );
  const summary = { available: 0, held: 0, booked: 0 };
  for (const r of rows) summary[r.status] = r.count;
  summary.total = summary.available + summary.held + summary.booked;
  return summary;
}
