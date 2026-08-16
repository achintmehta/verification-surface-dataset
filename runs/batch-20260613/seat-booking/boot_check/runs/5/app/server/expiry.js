/**
 * Hold expiry logic.
 * Provides a function to sweep expired holds and release their seats,
 * plus a periodic background sweep.
 */

import { getDb } from './db.js';
import { broadcast } from './sse.js';

/**
 * Release all holds whose expires_at is in the past.
 * Returns the list of seat ids that were released.
 * Must be called inside a PGLite transaction context or standalone.
 *
 * @param {import('@electric-sql/pglite').PGlite} db
 * @returns {Promise<Array<{id: string, row_label: string, seat_number: number}>>}
 */
export async function releaseExpiredHolds(db) {
  // Find seats that are held but whose hold has expired
  const expired = await db.query(`
    SELECT s.id, s.row_label, s.seat_number, s.hold_id
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
  `, [expiredSeatIds]);

  // Mark holds as not confirmed (they're expired, but keep record)
  if (expiredHoldIds.length > 0) {
    await db.query(`
      DELETE FROM holds
      WHERE id = ANY($1::text[])
        AND confirmed = FALSE
    `, [expiredHoldIds]);
  }

  return expired.rows;
}

/**
 * Sweep expired holds and broadcast releases.
 * Safe to call at any time.
 */
export async function sweepExpiredHolds() {
  try {
    const db = await getDb();
    const released = await releaseExpiredHolds(db);

    if (released.length > 0) {
      console.log(`[expiry] Released ${released.length} expired seat(s):`, released.map(r => r.id));
      broadcast('released', released.map(r => ({
        id: r.id,
        status: 'available',
        holdId: null,
      })));
    }
  } catch (err) {
    console.error('[expiry] Sweep error:', err.message);
  }
}

/**
 * Start the periodic expiry sweep.
 * @param {number} intervalMs - How often to sweep (default: 5 seconds)
 */
export function startExpirySweep(intervalMs = 5000) {
  const timer = setInterval(sweepExpiredHolds, intervalMs);
  // Don't block process exit
  if (timer.unref) timer.unref();
  console.log(`[expiry] Periodic sweep started every ${intervalMs}ms`);
  return timer;
}
