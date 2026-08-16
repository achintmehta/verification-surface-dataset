/**
 * Hold expiry helpers.
 *
 * expireStaleHolds(db) – releases all holds whose expires_at is in the past
 * and returns the list of seat rows that were freed so the caller can broadcast.
 *
 * IMPORTANT: This function must always be called inside an open transaction
 * (after BEGIN) and the caller is responsible for COMMIT/ROLLBACK.
 *
 * This is called:
 *   • before every seat-read (in its own committed transaction)
 *   • before every hold/confirm operation (in its own committed transaction)
 *   • on a periodic timer (background sweep)
 */

/**
 * Release all stale holds inside the given db connection.
 * Returns an array of freed seat objects { id, row_label, seat_number, hold_id }.
 *
 * Must be called inside an open transaction.
 */
export async function expireStaleHolds(db) {
  // Find seats that are held but whose hold has expired
  const { rows: expiredSeats } = await db.query(`
    SELECT s.id, s.row_label, s.seat_number, s.hold_id
    FROM   seats s
    WHERE  s.status = 'held'
      AND  s.hold_expires_at IS NOT NULL
      AND  s.hold_expires_at < NOW()
  `);

  if (expiredSeats.length === 0) return [];

  const expiredHoldIds = [...new Set(expiredSeats.map(s => s.hold_id).filter(Boolean))];

  // Reset seats to available
  await db.query(`
    UPDATE seats
    SET    status = 'available',
           hold_id = NULL,
           hold_expires_at = NULL
    WHERE  status = 'held'
      AND  hold_expires_at IS NOT NULL
      AND  hold_expires_at < NOW()
  `);

  // Mark holds as expired
  if (expiredHoldIds.length > 0) {
    const placeholders = expiredHoldIds.map((_, i) => `$${i + 1}`).join(', ');
    await db.query(
      `UPDATE holds SET status = 'expired' WHERE id IN (${placeholders}) AND status = 'active'`,
      expiredHoldIds
    );
  }

  return expiredSeats;
}
