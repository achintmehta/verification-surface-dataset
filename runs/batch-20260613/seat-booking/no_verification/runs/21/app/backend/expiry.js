import { getDb } from './db.js';
import { broadcast } from './sse.js';

/**
 * Expire stale holds: update seats whose hold has expired back to available,
 * update hold records to 'expired', and broadcast the changes.
 *
 * This is called:
 *  - Before every seat read (GET /api/seats)
 *  - Before every hold/confirm operation
 *  - Periodically via a sweep interval
 *
 * Returns array of seat objects that were released.
 */
export async function expireStaleHolds() {
  const db = await getDb();

  // Use a transaction to atomically find and release expired holds
  const released = await db.transaction(async (tx) => {
    // Find seats with expired holds
    const expiredSeats = await tx.query(`
      UPDATE seats
      SET status = 'available',
          hold_id = NULL,
          hold_expires_at = NULL,
          session_id = NULL
      WHERE status = 'held'
        AND hold_expires_at IS NOT NULL
        AND hold_expires_at <= NOW()
      RETURNING id, row_label, seat_number, status
    `);

    if (expiredSeats.rows.length > 0) {
      // Also update the holds table for these expired holds
      // Collect unique hold_ids from these seats before we cleared them
      // Since we already cleared them, let's update holds table by looking for active holds past expiry
      await tx.query(`
        UPDATE holds
        SET status = 'expired'
        WHERE status = 'active'
          AND expires_at <= NOW()
      `);
    }

    return expiredSeats.rows;
  });

  // Broadcast releases outside of transaction
  if (released.length > 0) {
    for (const seat of released) {
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

  return released;
}

let sweepInterval = null;

export function startSweep(intervalMs = 5000) {
  if (sweepInterval) return;
  sweepInterval = setInterval(async () => {
    try {
      await expireStaleHolds();
    } catch (e) {
      console.error('Sweep error:', e);
    }
  }, intervalMs);
}

export function stopSweep() {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}
