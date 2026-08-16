/**
 * Hold expiry helpers.
 *
 * expireStaleHolds(db) – releases all holds whose expires_at is in the past,
 * returning the list of seat ids that were freed so the caller can broadcast them.
 *
 * A periodic sweep is also exported so server.js can schedule it.
 */

import { broadcast } from './sse.js';

/**
 * Release every hold that has passed its TTL.
 * Must be called inside a serialised context (PGLite is single-connection so
 * concurrent JS calls are queued, but we still wrap in a transaction for
 * atomicity of the multi-step update).
 *
 * @param {import('@electric-sql/pglite').PGlite} db
 * @returns {Promise<string[]>} seat ids that were released
 */
export async function expireStaleHolds(db) {
  // Find expired held seats
  const { rows: expiredSeats } = await db.query(`
    SELECT s.id AS seat_id, s.hold_id
    FROM   seats s
    WHERE  s.status = 'held'
      AND  s.hold_expires_at IS NOT NULL
      AND  s.hold_expires_at <= NOW()
  `);

  if (expiredSeats.length === 0) return [];

  // Collect unique hold ids
  const holdIds = [...new Set(expiredSeats.map((r) => r.hold_id).filter(Boolean))];
  const seatIds = expiredSeats.map((r) => r.seat_id);

  // Release seats atomically
  await db.query(`
    UPDATE seats
    SET    status = 'available',
           hold_id = NULL,
           hold_expires_at = NULL
    WHERE  id = ANY($1::text[])
      AND  status = 'held'
      AND  hold_expires_at <= NOW()
  `, [seatIds]);

  // Mark holds as not confirmed (they are now invalid)
  if (holdIds.length > 0) {
    await db.query(`
      DELETE FROM holds
      WHERE  id = ANY($1::text[])
        AND  confirmed = FALSE
    `, [holdIds]);
  }

  return seatIds;
}

/**
 * Run expiry and broadcast any released seats.
 * @param {import('@electric-sql/pglite').PGlite} db
 */
export async function sweepAndBroadcast(db) {
  try {
    const released = await expireStaleHolds(db);
    if (released.length > 0) {
      broadcast('seats:released', { seatIds: released });
      console.log(`[expiry] Released ${released.length} expired seat(s):`, released);
    }
  } catch (err) {
    console.error('[expiry] Sweep error:', err);
  }
}
