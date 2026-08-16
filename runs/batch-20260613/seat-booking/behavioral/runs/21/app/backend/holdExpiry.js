import { broadcast } from './sse.js';

/**
 * Release all expired holds in the database.
 * Returns the seats that were released.
 */
export async function releaseExpiredHolds(db) {
  // Find expired held seats and release them atomically
  const result = await db.query(`
    UPDATE seats
    SET status = 'available',
        hold_id = NULL,
        hold_expires_at = NULL,
        session_id = NULL
    WHERE status = 'held'
      AND hold_expires_at IS NOT NULL
      AND hold_expires_at <= NOW()
    RETURNING id, row_label, seat_number
  `);

  if (result.rows.length > 0) {
    // Broadcast each released seat
    for (const seat of result.rows) {
      broadcast('seat-update', {
        id: seat.id,
        row_label: seat.row_label,
        seat_number: seat.seat_number,
        status: 'available',
        hold_id: null,
        hold_expires_at: null,
        session_id: null,
        booked_by: null,
      });
    }
  }

  return result.rows;
}

/**
 * Start a periodic sweep for expired holds.
 */
export function startExpirySweep(db, intervalMs = 1000) {
  const timer = setInterval(async () => {
    try {
      await releaseExpiredHolds(db);
    } catch (err) {
      console.error('Expiry sweep error:', err);
    }
  }, intervalMs);
  // Allow the process to exit even if timer is active
  if (timer.unref) timer.unref();
  return timer;
}
