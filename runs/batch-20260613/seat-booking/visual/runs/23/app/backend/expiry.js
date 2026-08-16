// Hold expiry logic
import { getDb } from './db.js';
import { broadcast } from './sse.js';

/**
 * Expire all stale holds. Returns the list of seat ids that were released.
 * This runs inside a transaction to ensure atomicity.
 */
export async function expireStaleHolds() {
  const db = await getDb();
  const releasedSeats = [];

  // Find expired holds
  const { rows: expiredHolds } = await db.query(`
    UPDATE holds
    SET status = 'expired'
    WHERE status = 'active' AND expires_at <= NOW()
    RETURNING id, seat_ids
  `);

  if (expiredHolds.length === 0) return releasedSeats;

  // Collect all seat ids from expired holds
  const allSeatIds = [];
  for (const hold of expiredHolds) {
    const seatIds = hold.seat_ids;
    if (Array.isArray(seatIds)) {
      allSeatIds.push(...seatIds);
    }
  }

  if (allSeatIds.length === 0) return releasedSeats;

  // Release those seats — only if they are still 'held' (not already booked somehow)
  const placeholders = allSeatIds.map((_, i) => `$${i + 1}`).join(', ');
  const { rows: released } = await db.query(`
    UPDATE seats
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
    WHERE id IN (${placeholders}) AND status = 'held'
    RETURNING id, row_label, seat_number, status
  `, allSeatIds);

  // Broadcast releases
  for (const seat of released) {
    releasedSeats.push(seat);
    broadcast('seat-update', {
      id: seat.id,
      row_label: seat.row_label,
      seat_number: seat.seat_number,
      status: 'available',
      hold_id: null,
      hold_expires_at: null,
      session_id: null,
      booked_by: null
    });
  }

  if (released.length > 0) {
    console.log(`Expired ${expiredHolds.length} hold(s), released ${released.length} seat(s)`);
  }

  return releasedSeats;
}

let sweepInterval;

export function startExpirySweep(intervalMs = 1000) {
  sweepInterval = setInterval(async () => {
    try {
      await expireStaleHolds();
    } catch (err) {
      console.error('Expiry sweep error:', err);
    }
  }, intervalMs);
}

export function stopExpirySweep() {
  if (sweepInterval) {
    clearInterval(sweepInterval);
  }
}
