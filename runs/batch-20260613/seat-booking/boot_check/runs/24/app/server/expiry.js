// Hold expiry enforcement
// Lazy: called before reads and operations
// Periodic: sweep timer

import { broadcast } from './sse.js';

/**
 * Expire all stale holds and release their seats.
 * Returns the list of seat ids that were released.
 */
export async function expireStaleHolds(db) {
  // In a single transaction: find expired holds, release their seats, mark holds expired
  const result = await db.query(`
    UPDATE seats
    SET status = 'available',
        hold_id = NULL,
        hold_expires_at = NULL,
        session_id = NULL
    WHERE status = 'held'
      AND hold_expires_at IS NOT NULL
      AND hold_expires_at < NOW()
    RETURNING id, row_label, seat_number
  `);

  if (result.rows.length > 0) {
    // Mark the corresponding holds as expired
    const releasedSeatIds = result.rows.map(r => r.id);
    await db.query(`
      UPDATE holds
      SET status = 'expired'
      WHERE status = 'active'
        AND expires_at < NOW()
    `);

    // Broadcast releases
    for (const seat of result.rows) {
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
  }

  return result.rows;
}

let sweepInterval = null;

export function startPeriodicSweep(db, intervalMs = 1000) {
  if (sweepInterval) clearInterval(sweepInterval);
  sweepInterval = setInterval(async () => {
    try {
      await expireStaleHolds(db);
    } catch (err) {
      console.error('Sweep error:', err);
    }
  }, intervalMs);
  return sweepInterval;
}

export function stopPeriodicSweep() {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}
