/**
 * Hold expiry module.
 *
 * `releaseExpiredHolds(db)` atomically releases all holds whose `expires_at`
 * is in the past, returning the seats that were freed so callers can broadcast.
 *
 * This is called:
 *   - Before every seat read (lazy expiry on GET /api/seats)
 *   - On a periodic timer (background sweep)
 *
 * Inside transactions, the holds route uses its own inline expiry logic
 * to avoid nested transaction issues.
 */

import { broadcast } from './sse.js';

/**
 * Release all expired holds and return the freed seat rows.
 * Runs as its own transaction (not nested).
 *
 * @param {import('@electric-sql/pglite').PGlite} db
 * @returns {Promise<Array>} freed seat rows
 */
export async function releaseExpiredHolds(db) {
  // Find expired hold ids.
  const { rows: expiredHolds } = await db.query(`
    SELECT id FROM holds
    WHERE  confirmed = FALSE
      AND  expires_at <= NOW()
  `);

  if (expiredHolds.length === 0) return [];

  const expiredIds = expiredHolds.map(h => h.id);
  const placeholders = expiredIds.map((_, i) => `$${i + 1}`).join(', ');

  // Free the seats.
  const { rows: freedSeats } = await db.query(
    `UPDATE seats
     SET    status          = 'available',
            hold_id         = NULL,
            hold_expires_at = NULL
     WHERE  hold_id IN (${placeholders})
       AND  status = 'held'
     RETURNING id, row_label, seat_number, status`,
    expiredIds
  );

  // Delete the expired holds.
  await db.query(
    `DELETE FROM holds WHERE id IN (${placeholders})`,
    expiredIds
  );

  if (freedSeats.length > 0) {
    broadcast('released', freedSeats.map(s => ({ id: s.id, status: 'available' })));
  }

  return freedSeats;
}

/**
 * Start a periodic background sweep that releases expired holds.
 * Returns a handle that can be cleared with clearInterval.
 *
 * @param {import('@electric-sql/pglite').PGlite} db
 * @param {number} intervalMs
 */
export function startExpirySweep(db, intervalMs = 5000) {
  return setInterval(async () => {
    try {
      await releaseExpiredHolds(db);
    } catch (err) {
      // Non-fatal; log and continue.
      console.error('[expiry sweep]', err.message);
    }
  }, intervalMs);
}
