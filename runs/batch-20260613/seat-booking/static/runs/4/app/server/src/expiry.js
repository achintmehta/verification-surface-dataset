/**
 * Hold-expiry helpers.
 *
 * `releaseExpiredHolds` is called:
 *   - before every seat-read (lazy expiry)
 *   - before every hold / confirm operation (transactional safety)
 *   - on a periodic timer (background sweep)
 *
 * When holds are released their seats transition back to `available` and the
 * change is broadcast to all SSE clients.
 */

import { query, transaction } from './db.js';
import { broadcast } from './sse.js';

/**
 * Release all holds whose `expires_at` is in the past.
 * Returns the list of seat ids that were freed.
 *
 * @returns {Promise<string[]>} freed seat ids
 */
export async function releaseExpiredHolds() {
  // Find expired holds that are not yet confirmed and still have held seats
  const { rows: expiredHolds } = await query(`
    SELECT h.id AS hold_id
    FROM   holds h
    WHERE  h.expires_at < NOW()
      AND  h.confirmed  = FALSE
      AND  EXISTS (
             SELECT 1 FROM seats s
             WHERE  s.hold_id = h.id
               AND  s.status  = 'held'
           )
  `);

  if (expiredHolds.length === 0) return [];

  const freedSeatIds = [];

  for (const { hold_id } of expiredHolds) {
    const freed = await transaction(async (tx) => {
      // Re-check inside transaction to avoid TOCTOU
      const { rows: holdRows } = await tx.query(
        `SELECT id, expires_at, confirmed FROM holds WHERE id = $1`,
        [hold_id]
      );
      if (holdRows.length === 0) return [];
      const hold = holdRows[0];
      if (hold.confirmed) return [];
      if (new Date(hold.expires_at) > new Date()) return [];

      // Release the seats
      const { rows: seatRows } = await tx.query(
        `UPDATE seats
         SET    status          = 'available',
                hold_id         = NULL,
                hold_expires_at = NULL
         WHERE  hold_id = $1
           AND  status  = 'held'
         RETURNING id`,
        [hold_id]
      );

      return seatRows.map((r) => r.id);
    });

    if (freed.length > 0) {
      // Broadcast per-hold so clients can identify their own expired hold
      broadcast('seats_released', {
        holdId: hold_id,
        seatIds: freed,
        reason: 'expired',
      });
      freedSeatIds.push(...freed);
    }
  }

  return freedSeatIds;
}

/**
 * Start a background timer that periodically sweeps for expired holds.
 *
 * @param {number} [intervalMs=10000]
 */
export function startExpirySweep(intervalMs = 10_000) {
  setInterval(async () => {
    try {
      const freed = await releaseExpiredHolds();
      if (freed.length > 0) {
        console.log(`[expiry sweep] Released ${freed.length} seat(s):`, freed);
      }
    } catch (err) {
      console.error('[expiry sweep] Error:', err);
    }
  }, intervalMs);
}
