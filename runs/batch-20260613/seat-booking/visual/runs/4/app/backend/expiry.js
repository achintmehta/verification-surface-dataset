/**
 * Hold expiry utilities.
 * Releases holds whose expires_at is in the past and broadcasts the changes.
 */

import { broadcastSeatUpdates } from './sse.js';

/**
 * Release all expired holds within the given db transaction/connection.
 * Returns the list of seat rows that were released.
 *
 * IMPORTANT: This must be called inside a serializable transaction so that
 * the check-and-set is atomic.
 *
 * @param {import('@electric-sql/pglite').PGlite} db
 * @returns {Promise<Array>} released seat rows
 */
export async function releaseExpiredHolds(db) {
  // Find seats that are held but whose hold has expired
  const expired = await db.query(`
    SELECT s.id, s.hold_id
    FROM seats s
    WHERE s.status = 'held'
      AND s.hold_expires_at IS NOT NULL
      AND s.hold_expires_at <= NOW()
  `);

  if (expired.rows.length === 0) return [];

  const expiredHoldIds = [...new Set(expired.rows.map(r => r.hold_id).filter(Boolean))];
  const expiredSeatIds = expired.rows.map(r => r.id);

  // Release the seats
  await db.query(`
    UPDATE seats
    SET status = 'available',
        hold_id = NULL,
        hold_expires_at = NULL
    WHERE id = ANY($1::text[])
      AND status = 'held'
      AND hold_expires_at <= NOW()
  `, [expiredSeatIds]);

  // Mark holds as not confirmed (they're expired, but keep the record for idempotency)
  if (expiredHoldIds.length > 0) {
    await db.query(`
      DELETE FROM holds
      WHERE id = ANY($1::text[])
        AND confirmed = FALSE
        AND expires_at <= NOW()
    `, [expiredHoldIds]);
  }

  return expiredSeatIds.map(id => ({ id, status: 'available', hold_id: null, booked_by: null }));
}

/**
 * Periodic sweep: release expired holds and broadcast.
 * @param {import('@electric-sql/pglite').PGlite} db
 */
export async function sweepExpiredHolds(db) {
  try {
    await db.transaction(async (tx) => {
      const released = await releaseExpiredHolds(tx);
      if (released.length > 0) {
        console.log(`[sweep] Released ${released.length} expired seat(s):`, released.map(s => s.id));
        broadcastSeatUpdates(released);
      }
    });
  } catch (err) {
    console.error('[sweep] Error releasing expired holds:', err.message);
  }
}

/**
 * Start the periodic expiry sweep.
 * @param {import('@electric-sql/pglite').PGlite} db
 * @param {number} intervalMs
 */
export function startExpirySweep(db, intervalMs = 5000) {
  setInterval(() => sweepExpiredHolds(db), intervalMs);
  console.log(`[sweep] Expiry sweep started (every ${intervalMs}ms)`);
}
