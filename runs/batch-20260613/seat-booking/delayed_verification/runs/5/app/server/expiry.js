/**
 * Hold expiry utilities.
 * Provides a function to sweep expired holds and release their seats,
 * plus a periodic background sweep.
 */

import { getDb } from './db.js';
import { broadcastSeatUpdate } from './sse.js';

/**
 * Release all holds whose expires_at is in the past.
 * Returns the list of seat objects that were released.
 * Must be called inside a PGlite transaction or standalone.
 *
 * @param {import('@electric-sql/pglite').PGlite} db
 * @returns {Promise<Array>}  released seat rows
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

  const holdIds = [...new Set(expired.rows.map(r => r.hold_id).filter(Boolean))];
  const seatIds = expired.rows.map(r => r.id);

  // Release the seats
  await db.query(`
    UPDATE seats
    SET status = 'available',
        hold_id = NULL,
        hold_expires_at = NULL
    WHERE id = ANY($1)
  `, [seatIds]);

  // Mark holds as expired
  if (holdIds.length > 0) {
    await db.query(`
      UPDATE holds
      SET status = 'expired'
      WHERE id = ANY($1)
        AND status = 'active'
    `, [holdIds]);
  }

  // Fetch updated seat rows to broadcast
  const updated = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
    FROM seats
    WHERE id = ANY($1)
  `, [seatIds]);

  return updated.rows;
}

/**
 * Start a periodic background sweep that releases expired holds
 * and broadcasts the changes to all SSE clients.
 *
 * @param {number} intervalMs  how often to sweep (default 5 s)
 */
export function startExpirySweep(intervalMs = 5000) {
  const sweep = async () => {
    try {
      const db = await getDb();
      const released = await releaseExpiredHolds(db);
      if (released.length > 0) {
        console.log(`[expiry sweep] Released ${released.length} seat(s).`);
        broadcastSeatUpdate(released);
      }
    } catch (err) {
      console.error('[expiry sweep] Error:', err.message);
    }
  };

  const handle = setInterval(sweep, intervalMs);
  // Don't block process exit
  if (handle.unref) handle.unref();
  return handle;
}
