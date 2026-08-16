/**
 * Expiry module.
 * Provides a helper that releases all holds whose expires_at is in the past
 * and broadcasts the resulting seat transitions.
 * Called before every seat read and before every hold/confirm operation,
 * and also on a periodic timer.
 */
import { getDb } from './db.js';
import { broadcast } from './sse.js';

/**
 * Release all expired holds.
 * Returns the list of seat ids that were released.
 * @returns {Promise<string[]>}
 */
export async function releaseExpiredHolds() {
  const db = getDb();

  // Find seats that are held but whose hold has expired
  const { rows: expiredSeats } = await db.query(`
    SELECT s.id, s.hold_id
    FROM seats s
    WHERE s.status = 'held'
      AND s.hold_expires_at IS NOT NULL
      AND s.hold_expires_at < NOW()
  `);

  if (expiredSeats.length === 0) return [];

  const seatIds = expiredSeats.map((r) => r.id);
  const holdIds = [...new Set(expiredSeats.map((r) => r.hold_id).filter(Boolean))];

  // Reset seats to available
  await db.query(`
    UPDATE seats
    SET status = 'available',
        hold_id = NULL,
        hold_expires_at = NULL
    WHERE id = ANY($1)
  `, [seatIds]);

  // Mark holds as released
  if (holdIds.length > 0) {
    await db.query(`
      UPDATE holds
      SET released = TRUE
      WHERE id = ANY($1)
        AND confirmed = FALSE
    `, [holdIds]);
  }

  // Broadcast each released seat
  for (const seat of expiredSeats) {
    broadcast('seat:released', { seatId: seat.id, status: 'available' });
  }

  console.log(`Released ${seatIds.length} expired seat(s): ${seatIds.join(', ')}`);
  return seatIds;
}

/**
 * Start a periodic sweep that releases expired holds every `intervalMs` ms.
 * @param {number} intervalMs
 */
export function startExpirySweep(intervalMs = 5000) {
  setInterval(async () => {
    try {
      await releaseExpiredHolds();
    } catch (err) {
      console.error('Expiry sweep error:', err);
    }
  }, intervalMs);
}
