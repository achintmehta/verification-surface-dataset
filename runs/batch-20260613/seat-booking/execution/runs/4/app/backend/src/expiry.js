/**
 * expiry.js – Hold expiry helpers.
 *
 * `releaseExpiredHolds(db)` is the single authoritative function that:
 *   1. Finds all seats whose hold has expired (hold_expires_at < NOW()).
 *   2. Resets them to `available` in a single atomic UPDATE.
 *   3. Cleans up the corresponding rows in the `holds` table.
 *   4. Returns the list of affected seat ids so the caller can broadcast.
 *
 * It is called:
 *   - Before every seat-read (GET /api/seats).
 *   - Inside every hold/confirm transaction (as the first step).
 *   - By a periodic background sweep every 15 seconds.
 */

import { broadcast } from './sse.js';

/**
 * Release all expired holds and return the freed seat ids.
 *
 * @param {import('@electric-sql/pglite').PGlite} db
 * @returns {Promise<string[]>} seat ids that were released
 */
export async function releaseExpiredHolds(db) {
  // Find seats that are held but whose TTL has elapsed.
  const { rows: expiredSeats } = await db.query(`
    SELECT s.id, s.hold_id
    FROM   seats s
    WHERE  s.status = 'held'
      AND  s.hold_expires_at IS NOT NULL
      AND  s.hold_expires_at < NOW()
  `);

  if (expiredSeats.length === 0) return [];

  const seatIds = expiredSeats.map((r) => r.id);
  const holdIds = [...new Set(expiredSeats.map((r) => r.hold_id).filter(Boolean))];

  // Reset seats to available.
  const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
  await db.query(
    `UPDATE seats
     SET    status          = 'available',
            hold_id         = NULL,
            hold_expires_at = NULL
     WHERE  id IN (${placeholders})`,
    seatIds
  );

  // Remove the expired hold records.
  if (holdIds.length > 0) {
    const hPlaceholders = holdIds.map((_, i) => `$${i + 1}`).join(', ');
    await db.query(
      `DELETE FROM holds WHERE id IN (${hPlaceholders}) AND confirmed = FALSE`,
      holdIds
    );
  }

  return seatIds;
}

/**
 * Start a periodic background sweep that releases expired holds and broadcasts
 * the resulting seat-status changes.
 *
 * @param {import('@electric-sql/pglite').PGlite} db
 * @param {number} intervalMs  – sweep interval in milliseconds (default 15 s)
 */
export function startExpirySweep(db, intervalMs = 15_000) {
  setInterval(async () => {
    try {
      const freed = await releaseExpiredHolds(db);
      if (freed.length > 0) {
        console.log(`[expiry] Released ${freed.length} expired seat(s): ${freed.join(', ')}`);
        broadcast('seat-update', {
          type: 'released',
          seatIds: freed,
          status: 'available',
        });
      }
    } catch (err) {
      console.error('[expiry] Sweep error:', err);
    }
  }, intervalMs);
}
