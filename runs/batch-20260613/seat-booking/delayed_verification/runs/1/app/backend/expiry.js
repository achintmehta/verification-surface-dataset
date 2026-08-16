/**
 * expiry.js – Hold expiry logic.
 *
 * Two entry points:
 *   sweepExpiredHolds(db)  – called periodically and before every mutation
 *   effectiveStatus(seat)  – returns the real status of a seat row, treating
 *                            expired holds as 'available'
 */

import { broadcast } from './sse.js';

/**
 * Release all holds whose expires_at is in the past and that have not yet
 * been confirmed.  Returns the array of seat ids that were released so the
 * caller can broadcast them.
 *
 * MUST be called inside a transaction (tx) so the release is atomic with
 * whatever operation follows it.
 */
export async function sweepExpiredHolds(tx) {
  // Find seats that are still marked 'held' but whose hold has expired.
  const { rows: expired } = await tx.query(`
    SELECT id, hold_id
    FROM   seats
    WHERE  status = 'held'
      AND  hold_expires_at IS NOT NULL
      AND  hold_expires_at <= NOW()
  `);

  if (expired.length === 0) return [];

  const seatIds  = expired.map((r) => r.id);
  const holdIds  = [...new Set(expired.map((r) => r.hold_id).filter(Boolean))];

  // Reset the seats to available.
  await tx.query(`
    UPDATE seats
    SET    status          = 'available',
           hold_id         = NULL,
           hold_expires_at = NULL
    WHERE  id = ANY($1)
  `, [seatIds]);

  // Mark the corresponding holds as expired (not confirmed, just abandoned).
  if (holdIds.length > 0) {
    await tx.query(`
      DELETE FROM holds
      WHERE  id = ANY($1)
        AND  confirmed = FALSE
    `, [holdIds]);
  }

  return seatIds;
}

/**
 * Compute the effective status of a seat row without touching the DB.
 * Used when returning seat data to clients so expired holds appear available.
 */
export function effectiveStatus(seat) {
  if (seat.status === 'held') {
    if (!seat.hold_expires_at) return 'available';
    const exp = new Date(seat.hold_expires_at);
    if (exp <= new Date()) return 'available';
  }
  return seat.status;
}

/**
 * Broadcast released seat ids after a sweep.
 */
export function broadcastReleases(releasedSeatIds) {
  if (releasedSeatIds.length === 0) return;
  broadcast('seats_released', { seatIds: releasedSeatIds });
}
