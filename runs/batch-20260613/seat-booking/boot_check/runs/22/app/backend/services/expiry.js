import { getDb } from '../db.js';

/**
 * Expire all holds past their TTL. Returns an array of seat objects that changed.
 * This is called both lazily (before reads/writes) and periodically (sweep).
 */
export async function expireHolds() {
  const db = getDb();
  const changed = [];

  // Find seats with expired holds
  const expiredSeats = await db.query(`
    SELECT s.id, s.row_label, s.seat_number, s.hold_id
    FROM seats s
    WHERE s.status = 'held'
      AND s.hold_expires_at IS NOT NULL
      AND s.hold_expires_at <= NOW()
  `);

  if (expiredSeats.rows.length === 0) {
    return changed;
  }

  // Collect unique hold_ids to mark as expired
  const holdIds = [...new Set(expiredSeats.rows.map(r => r.hold_id).filter(Boolean))];
  const seatIds = expiredSeats.rows.map(r => r.id);

  // Release the seats
  if (seatIds.length > 0) {
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
    await db.query(
      `UPDATE seats 
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
       WHERE id IN (${placeholders}) AND status = 'held'`,
      seatIds
    );
  }

  // Mark holds as expired
  for (const holdId of holdIds) {
    await db.query(
      `UPDATE holds SET status = 'expired' WHERE id = $1 AND status = 'active'`,
      [holdId]
    );
  }

  // Return the changed seats for broadcasting
  for (const seat of expiredSeats.rows) {
    changed.push({
      id: seat.id,
      row_label: seat.row_label,
      seat_number: seat.seat_number,
      status: 'available',
      hold_id: null,
      hold_expires_at: null,
      booked_by: null,
    });
  }

  return changed;
}
