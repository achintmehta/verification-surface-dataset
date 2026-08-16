/**
 * Hold expiry helpers.
 *
 * `releaseExpiredHolds` is called:
 *   - before every seat read (lazy expiry)
 *   - before every hold / confirm operation
 *   - on a periodic timer (background sweep)
 *
 * It runs inside the serialised queue so it is safe to call from anywhere.
 */

import { transaction } from './db.js';
import { broadcast } from './sse.js';

/**
 * Release all holds whose `expires_at` is in the past.
 * Returns the list of seat ids that were freed so callers can log / test.
 *
 * @returns {Promise<string[]>} freed seat ids
 */
export async function releaseExpiredHolds() {
  return transaction(async (db) => {
    // Find seats that are held but whose hold has expired
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

    // Reset the seats to available
    for (const id of seatIds) {
      await db.query(
        `UPDATE seats
         SET    status = 'available',
                hold_id = NULL,
                hold_expires_at = NULL
         WHERE  id = $1`,
        [id]
      );
    }

    // Mark the holds as expired (delete them so they can't be confirmed)
    for (const hid of holdIds) {
      await db.query('DELETE FROM holds WHERE id = $1', [hid]);
    }

    return seatIds;
  }).then((freedIds) => {
    if (freedIds.length > 0) {
      console.log(`[expiry] Released ${freedIds.length} seat(s): ${freedIds.join(', ')}`);
      // Broadcast each freed seat
      for (const id of freedIds) {
        broadcast('seat-update', { id, status: 'available' });
      }
    }
    return freedIds;
  });
}

/**
 * Start a periodic background sweep that releases expired holds.
 * @param {number} intervalMs  default 10 seconds
 */
export function startExpirySweep(intervalMs = 10_000) {
  const timer = setInterval(async () => {
    try {
      await releaseExpiredHolds();
    } catch (err) {
      console.error('[expiry] Sweep error:', err);
    }
  }, intervalMs);

  // Don't keep the process alive just for the sweep
  if (timer.unref) timer.unref();

  console.log(`[expiry] Background sweep started (every ${intervalMs / 1000}s).`);
}
