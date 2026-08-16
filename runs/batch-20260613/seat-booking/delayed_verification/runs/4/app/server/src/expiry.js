/**
 * Hold expiry module.
 *
 * Provides:
 *  - `expireStaleHolds(db)` – releases all holds whose expires_at is in the
 *    past, marks their seats available, marks the hold released, and returns
 *    the affected seat rows so the caller can broadcast them.
 *  - `startExpiryWorker()` – runs expireStaleHolds on a periodic interval so
 *    abandoned holds are cleaned up even when no request triggers a read.
 *
 * This function is designed to be called INSIDE a withLock() block so it
 * never races with hold/confirm operations.
 */

import { getDb, withLock } from './db.js';
import { broadcast } from './sse.js';

/**
 * Release all expired holds.
 * Must be called while holding the DB lock (i.e. inside withLock).
 *
 * @param {import('@electric-sql/pglite').PGlite} db
 * @returns {Promise<object[]>} The seat rows that were released.
 */
export async function expireStaleHoldsUnsafe(db) {
  // Find seats whose hold has expired and are still in 'held' status.
  const { rows: expiredSeats } = await db.query(`
    SELECT id, row_label, seat_number, hold_id
    FROM   seats
    WHERE  status = 'held'
      AND  hold_expires_at IS NOT NULL
      AND  hold_expires_at < NOW()
  `);

  if (expiredSeats.length === 0) return [];

  // Collect unique hold ids to mark as released.
  const holdIds = [...new Set(expiredSeats.map((s) => s.hold_id).filter(Boolean))];

  // Release the seats.
  await db.query(`
    UPDATE seats
    SET    status          = 'available',
           hold_id         = NULL,
           hold_expires_at = NULL
    WHERE  status = 'held'
      AND  hold_expires_at < NOW()
  `);

  // Mark holds as released.
  if (holdIds.length > 0) {
    const placeholders = holdIds.map((_, i) => `$${i + 1}`).join(', ');
    await db.query(
      `UPDATE holds
       SET    released_at = NOW()
       WHERE  id IN (${placeholders})
         AND  released_at IS NULL
         AND  confirmed_at IS NULL`,
      holdIds,
    );
  }

  // Re-fetch the updated seat rows to broadcast accurate state.
  const seatIds = expiredSeats.map((s) => s.id);
  const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
  const { rows: updatedSeats } = await db.query(
    `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
     FROM   seats
     WHERE  id IN (${placeholders})`,
    seatIds,
  );

  return updatedSeats;
}

/**
 * Acquire the lock, expire stale holds, and broadcast the releases.
 */
export async function expireStaleHolds() {
  const db = await getDb();
  const released = await withLock(() => expireStaleHoldsUnsafe(db));
  if (released.length > 0) {
    console.log(`[expiry] Released ${released.length} expired seat(s).`);
    broadcast(released);
  }
  return released;
}

/**
 * Start a background interval that periodically sweeps for expired holds.
 *
 * @param {number} intervalMs  How often to sweep (default: 5 seconds).
 * @returns {NodeJS.Timeout}
 */
export function startExpiryWorker(intervalMs = 5_000) {
  console.log(`[expiry] Worker started (interval=${intervalMs}ms).`);
  return setInterval(async () => {
    try {
      await expireStaleHolds();
    } catch (err) {
      console.error('[expiry] Worker error:', err);
    }
  }, intervalMs);
}
