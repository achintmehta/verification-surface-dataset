/**
 * Hold expiry helpers.
 *
 * expireStaleHolds(db) – releases all holds whose expires_at is in the past,
 * returning the list of seat rows that were freed so the caller can broadcast.
 *
 * sweepExpiredHolds(db) – convenience wrapper used by the periodic background sweep.
 */

import { broadcast } from './sse.js';

/**
 * Release every hold that has passed its TTL.
 * Must be called inside a transaction or as a standalone operation.
 *
 * Returns the array of seat objects that were freed (may be empty).
 */
export async function expireStaleHolds(db) {
  // Find seats that are held but whose hold has expired
  const { rows: expiredSeats } = await db.query(`
    SELECT s.id, s.hold_id, s.row_label, s.seat_number
    FROM   seats s
    JOIN   holds h ON h.id = s.hold_id
    WHERE  s.status = 'held'
      AND  h.expires_at <= NOW()
  `);

  if (expiredSeats.length === 0) return [];

  // Collect unique hold ids to mark as not-confirmed (they just expire naturally)
  const holdIds = [...new Set(expiredSeats.map(r => r.hold_id))];

  // Release the seats
  const seatIds = expiredSeats.map(r => r.id);
  const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');

  await db.query(
    `UPDATE seats
     SET    status = 'available',
            hold_id = NULL,
            hold_expires_at = NULL
     WHERE  id IN (${placeholders})`,
    seatIds
  );

  // Delete the expired holds
  const holdPlaceholders = holdIds.map((_, i) => `$${i + 1}`).join(', ');
  await db.query(
    `DELETE FROM holds WHERE id IN (${holdPlaceholders})`,
    holdIds
  );

  return expiredSeats.map(r => ({ id: r.id, status: 'available' }));
}

/**
 * Background sweep: expire stale holds and broadcast releases.
 */
export async function sweepExpiredHolds(db) {
  try {
    const freed = await expireStaleHolds(db);
    if (freed.length > 0) {
      broadcast('released', freed);
    }
  } catch (err) {
    console.error('[sweep] Error expiring holds:', err.message);
  }
}
