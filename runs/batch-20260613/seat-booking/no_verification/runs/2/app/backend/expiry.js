/**
 * Hold expiry helpers.
 *
 * expireStaleHolds(db) – releases all holds whose expires_at is in the past
 * and returns the list of seat rows that were freed so callers can broadcast.
 *
 * This is called:
 *   • before every seat-read (lazy expiry)
 *   • before every hold/confirm operation (transactional safety)
 *   • on a periodic timer (background sweep)
 */

/**
 * Release all stale holds inside the given db connection.
 * Returns an array of freed seat objects: { id, row_label, seat_number, status:'available' }
 */
export async function expireStaleHolds(db) {
  // Find holds that are active but past their TTL
  const { rows: expiredHolds } = await db.query(`
    SELECT id FROM holds
    WHERE status = 'active'
      AND expires_at < NOW()
  `);

  if (expiredHolds.length === 0) return [];

  const expiredIds = expiredHolds.map((h) => `'${h.id}'`).join(', ');

  // Free the seats that belong to those holds
  const { rows: freedSeats } = await db.query(`
    UPDATE seats
    SET status          = 'available',
        hold_id         = NULL,
        hold_expires_at = NULL
    WHERE hold_id IN (${expiredIds})
      AND status = 'held'
    RETURNING id, row_label, seat_number, status
  `);

  // Mark the holds themselves as expired
  await db.query(`
    UPDATE holds
    SET status = 'expired'
    WHERE id IN (${expiredIds})
  `);

  return freedSeats;
}
