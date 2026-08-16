import { getDb } from "./db.js";
import { broadcast } from "./sse.js";

/**
 * Expire all holds whose TTL has passed.
 * Returns the list of seat ids that were released.
 */
export async function expireStaleHolds() {
  const db = await getDb();
  const released = [];

  // Find seats that are held but whose hold has expired
  const expiredSeats = await db.query(`
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

  if (expiredSeats.rows.length > 0) {
    // Also mark the corresponding holds as expired
    const expiredHoldIds = await db.query(`
      UPDATE holds
      SET status = 'expired'
      WHERE status = 'active'
        AND expires_at <= NOW()
      RETURNING id
    `);

    for (const seat of expiredSeats.rows) {
      released.push({
        id: seat.id,
        row_label: seat.row_label,
        seat_number: seat.seat_number,
        status: "available",
        hold_id: null,
        hold_expires_at: null,
        session_id: null,
        booked_by: null,
      });
    }

    // Broadcast releases
    broadcast("seats-updated", released);
  }

  return released;
}

let sweepInterval = null;

export function startPeriodicSweep(intervalMs = 1000) {
  if (sweepInterval) return;
  sweepInterval = setInterval(async () => {
    try {
      await expireStaleHolds();
    } catch (err) {
      console.error("Sweep error:", err);
    }
  }, intervalMs);
}

export function stopPeriodicSweep() {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}
