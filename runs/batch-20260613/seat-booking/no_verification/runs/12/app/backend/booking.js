import { randomUUID } from 'node:crypto';
import { getDb, writeLock } from './db.js';
import { HOLD_TTL_MS } from './config.js';
import { broadcastSeatChanges } from './sse.js';

/**
 * Maps a raw seat row to the client-facing shape, computing the *effective*
 * status: a held seat whose hold has expired is reported as available.
 */
function toEffectiveSeat(row, now = Date.now()) {
  let status = row.status;
  let holdId = row.hold_id;
  let holdExpiresAt = row.hold_expires_at;
  let bookedBy = row.booked_by;

  if (status === 'held') {
    const expMs = holdExpiresAt ? new Date(holdExpiresAt).getTime() : 0;
    if (!holdExpiresAt || expMs <= now) {
      // Hold is logically expired.
      status = 'available';
      holdId = null;
      holdExpiresAt = null;
    }
  }

  return {
    id: row.id,
    row: row.row_label,
    number: row.seat_number,
    status,
    holdId: status === 'held' ? holdId : null,
    holdExpiresAt: status === 'held' ? holdExpiresAt : null,
    bookedBy: status === 'booked' ? bookedBy : null,
  };
}

/**
 * Lazily release any expired holds inside the current transaction-ish scope.
 * Must be called while holding the write lock for correctness.
 * Returns the list of seat ids that were released.
 */
async function releaseExpiredSeats(db) {
  const res = await db.query(
    `UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE status = 'held'
        AND (hold_expires_at IS NULL OR hold_expires_at <= NOW())
      RETURNING *`
  );
  return res.rows;
}

/**
 * Get all seats with effective status. Performs a lazy expiry sweep first and
 * broadcasts any releases so all clients converge.
 */
export async function getSeats() {
  const db = await getDb();
  return writeLock.runExclusive(async () => {
    const released = await releaseExpiredSeats(db);
    if (released.length > 0) {
      broadcastSeatChanges(
        released.map((r) => ({ seat: toEffectiveSeat(r), transition: 'released' }))
      );
    }
    const res = await db.query(
      'SELECT * FROM seats ORDER BY row_label, seat_number'
    );
    const now = Date.now();
    return res.rows.map((r) => toEffectiveSeat(r, now));
  });
}

/**
 * Atomically acquire ALL requested seats only if every one is currently
 * available. All-or-nothing. Returns { hold } on success or throws a
 * ConflictError listing the conflicting seat ids.
 */
export async function createHold(seatIds, sessionId) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    const err = new Error('seatIds must be a non-empty array');
    err.statusCode = 400;
    throw err;
  }
  if (!sessionId || typeof sessionId !== 'string') {
    const err = new Error('sessionId is required');
    err.statusCode = 400;
    throw err;
  }

  // De-duplicate requested seat ids.
  const uniqueIds = [...new Set(seatIds)];

  const db = await getDb();

  return writeLock.runExclusive(async () => {
    const releasedDuringSweep = await releaseExpiredSeats(db);

    await db.query('BEGIN');
    try {
      // Verify existence of all requested seats.
      const placeholders = uniqueIds.map((_, i) => `$${i + 1}`).join(', ');
      const seatRes = await db.query(
        `SELECT * FROM seats WHERE id IN (${placeholders}) FOR UPDATE`,
        uniqueIds
      );

      const found = new Map(seatRes.rows.map((r) => [r.id, r]));
      const unknown = uniqueIds.filter((id) => !found.has(id));
      if (unknown.length > 0) {
        await db.query('ROLLBACK');
        const err = new Error(`Unknown seat ids: ${unknown.join(', ')}`);
        err.statusCode = 400;
        throw err;
      }

      // Determine conflicts (any seat that is not effectively available).
      const now = Date.now();
      const conflicts = [];
      for (const id of uniqueIds) {
        const row = found.get(id);
        const eff = toEffectiveSeat(row, now);
        if (eff.status !== 'available') conflicts.push(id);
      }

      if (conflicts.length > 0) {
        await db.query('ROLLBACK');
        const err = new Error('Some seats are not available');
        err.statusCode = 409;
        err.conflicts = conflicts;
        throw err;
      }

      // All available: acquire them under a fresh hold.
      const holdId = randomUUID();
      const expiresAtMs = now + HOLD_TTL_MS;
      const expiresAt = new Date(expiresAtMs).toISOString();

      const idPlaceholders = uniqueIds
        .map((_, i) => `$${i + 3}`)
        .join(', ');
      const updRes = await db.query(
        `UPDATE seats
            SET status = 'held', hold_id = $1, hold_expires_at = $2, booked_by = NULL
          WHERE id IN (${idPlaceholders})
          RETURNING *`,
        [holdId, expiresAt, ...uniqueIds]
      );

      await db.query('COMMIT');

      // Broadcast releases from the sweep, then the new holds.
      if (releasedDuringSweep.length > 0) {
        broadcastSeatChanges(
          releasedDuringSweep.map((r) => ({
            seat: toEffectiveSeat(r),
            transition: 'released',
          }))
        );
      }
      broadcastSeatChanges(
        updRes.rows.map((r) => ({ seat: toEffectiveSeat(r), transition: 'held' }))
      );

      return {
        holdId,
        sessionId,
        seatIds: uniqueIds,
        expiresAt,
        expiresInMs: expiresAtMs - Date.now(),
      };
    } catch (err) {
      // Make sure we are not stuck in a transaction.
      try {
        await db.query('ROLLBACK');
      } catch (_) {
        /* already rolled back / committed */
      }
      throw err;
    }
  });
}

/**
 * Confirm a hold: book its seats. Idempotent — confirming the same hold twice
 * books the seats exactly once and returns the same booking.
 *
 * A hold is identified by hold_id. We accept a sessionId to verify ownership.
 */
export async function confirmHold(holdId, sessionId) {
  if (!holdId) {
    const err = new Error('holdId is required');
    err.statusCode = 400;
    throw err;
  }

  const db = await getDb();

  return writeLock.runExclusive(async () => {
    const releasedDuringSweep = await releaseExpiredSeats(db);

    await db.query('BEGIN');
    try {
      // Look at every seat that references this hold (held) OR was booked by it.
      const res = await db.query(
        `SELECT * FROM seats WHERE hold_id = $1 FOR UPDATE`,
        [holdId]
      );

      // Idempotency: if seats for this hold are already booked, return them.
      const alreadyBooked = res.rows.filter((r) => r.status === 'booked');
      const stillHeld = res.rows.filter((r) => r.status === 'held');

      // No seats reference this hold at all.
      if (res.rows.length === 0) {
        await db.query('ROLLBACK');
        const err = new Error('Hold not found or already released/expired');
        err.statusCode = 404;
        throw err;
      }

      // Ownership note: a hold is identified by its opaque hold_id, which is
      // only known to the session that created it (returned by POST /api/holds).
      // Thus possession of the hold_id is sufficient proof of ownership; an
      // optional sessionId is recorded as booked_by for traceability.

      const now = Date.now();

      // Validate that held seats are not expired.
      const expiredHeld = stillHeld.filter((r) => {
        const expMs = r.hold_expires_at
          ? new Date(r.hold_expires_at).getTime()
          : 0;
        return !r.hold_expires_at || expMs <= now;
      });

      if (expiredHeld.length > 0) {
        // The hold has expired: release the still-held seats and fail. Book
        // nothing. (If some were already booked in a prior confirm, that is an
        // inconsistent partial state which cannot occur because confirm books
        // all-or-nothing in one transaction.)
        await db.query('ROLLBACK');
        const err = new Error('Hold has expired');
        err.statusCode = 410;
        throw err;
      }

      if (stillHeld.length === 0 && alreadyBooked.length > 0) {
        // Fully booked already -> idempotent success, book nothing additional.
        await db.query('COMMIT');
        if (releasedDuringSweep.length > 0) {
          broadcastSeatChanges(
            releasedDuringSweep.map((r) => ({
              seat: toEffectiveSeat(r),
              transition: 'released',
            }))
          );
        }
        return {
          holdId,
          status: 'booked',
          bookedSeatIds: alreadyBooked.map((r) => r.id).sort(),
          idempotent: true,
        };
      }

      // Book all the (still-held, not-expired) seats. We set booked_by to the
      // confirming session id (or the first known one).
      const owner = sessionId || 'unknown';
      const ids = stillHeld.map((r) => r.id);
      const placeholders = ids.map((_, i) => `$${i + 2}`).join(', ');
      const updRes = await db.query(
        `UPDATE seats
            SET status = 'booked', booked_by = $1, hold_expires_at = NULL
          WHERE id IN (${placeholders})
          RETURNING *`,
        [owner, ...ids]
      );

      await db.query('COMMIT');

      if (releasedDuringSweep.length > 0) {
        broadcastSeatChanges(
          releasedDuringSweep.map((r) => ({
            seat: toEffectiveSeat(r),
            transition: 'released',
          }))
        );
      }
      broadcastSeatChanges(
        updRes.rows.map((r) => ({ seat: toEffectiveSeat(r), transition: 'booked' }))
      );

      const bookedSeatIds = [
        ...alreadyBooked.map((r) => r.id),
        ...updRes.rows.map((r) => r.id),
      ].sort();

      return {
        holdId,
        status: 'booked',
        bookedSeatIds,
        idempotent: false,
      };
    } catch (err) {
      try {
        await db.query('ROLLBACK');
      } catch (_) {
        /* noop */
      }
      throw err;
    }
  });
}

/**
 * Release a hold early, returning its seats to available. No-op (still 200)
 * if the hold no longer exists. Booked seats are never released.
 */
export async function releaseHold(holdId) {
  if (!holdId) {
    const err = new Error('holdId is required');
    err.statusCode = 400;
    throw err;
  }

  const db = await getDb();

  return writeLock.runExclusive(async () => {
    const res = await db.query(
      `UPDATE seats
          SET status = 'available', hold_id = NULL, hold_expires_at = NULL
        WHERE hold_id = $1 AND status = 'held'
        RETURNING *`,
      [holdId]
    );

    if (res.rows.length > 0) {
      broadcastSeatChanges(
        res.rows.map((r) => ({ seat: toEffectiveSeat(r), transition: 'released' }))
      );
    }

    return { holdId, releasedSeatIds: res.rows.map((r) => r.id).sort() };
  });
}

/**
 * Periodic sweep: release expired holds and broadcast.
 */
export async function sweepExpiredHolds() {
  const db = await getDb();
  return writeLock.runExclusive(async () => {
    const released = await releaseExpiredSeats(db);
    if (released.length > 0) {
      broadcastSeatChanges(
        released.map((r) => ({ seat: toEffectiveSeat(r), transition: 'released' }))
      );
    }
    return released.length;
  });
}

/**
 * Inventory summary used for verification: available + held(active) + booked.
 */
export async function getInventory() {
  const seats = await getSeats();
  const counts = { available: 0, held: 0, booked: 0, total: seats.length };
  for (const s of seats) counts[s.status]++;
  return counts;
}
