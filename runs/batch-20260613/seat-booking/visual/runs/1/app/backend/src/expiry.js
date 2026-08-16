/**
 * expiry.js – Hold expiry logic.
 *
 * `releaseExpiredHolds(db)` is called:
 *   • before every seat read (lazy expiry on read)
 *   • before every hold/confirm operation (lazy expiry before write)
 *   • on a periodic timer (background sweep)
 *
 * It returns the list of seat ids that were released so the caller can
 * broadcast the transitions.
 */

import { broadcast } from './sse.js';

/**
 * Release all holds whose `expires_at` is in the past.
 * Must be called inside a `withDb` callback (db is already acquired).
 *
 * @param {object} db  – live PGLite instance
 * @returns {string[]} seat ids that were released
 */
export async function releaseExpiredHolds(db) {
  // Find expired holds that are not yet confirmed
  const { rows: expiredHolds } = await db.query(`
    SELECT id FROM holds
    WHERE expires_at <= NOW()
      AND confirmed = FALSE
  `);

  if (expiredHolds.length === 0) return [];

  const expiredIds = expiredHolds.map((h) => h.id);
  const placeholders = expiredIds.map((_, i) => `$${i + 1}`).join(', ');

  // Find the seats that belong to these holds
  const { rows: affectedSeats } = await db.query(
    `SELECT id FROM seats WHERE hold_id = ANY(ARRAY[${placeholders}]::text[])`,
    expiredIds
  );

  if (affectedSeats.length === 0) {
    // Clean up the hold records even if no seats reference them
    await db.query(
      `DELETE FROM holds WHERE id = ANY(ARRAY[${placeholders}]::text[])`,
      expiredIds
    );
    return [];
  }

  const seatIds = affectedSeats.map((s) => s.id);
  const seatPlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');

  // Release the seats atomically
  await db.query(
    `UPDATE seats
     SET status = 'available',
         hold_id = NULL,
         hold_expires_at = NULL
     WHERE id = ANY(ARRAY[${seatPlaceholders}]::text[])
       AND status = 'held'`,
    seatIds
  );

  // Remove the expired hold records
  await db.query(
    `DELETE FROM holds WHERE id = ANY(ARRAY[${placeholders}]::text[])`,
    expiredIds
  );

  return seatIds;
}

/**
 * Broadcast seat-released events for a list of seat ids.
 */
export function broadcastReleases(seatIds) {
  if (seatIds.length === 0) return;
  broadcast('seats_released', { seatIds });
  console.log(`[expiry] Released ${seatIds.length} seat(s): ${seatIds.join(', ')}`);
}
