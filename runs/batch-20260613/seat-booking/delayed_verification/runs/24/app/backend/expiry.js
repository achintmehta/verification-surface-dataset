import { getDb } from "./db.js";
import { broadcast } from "./sse.js";

/**
 * Expire all stale holds. Returns the list of seat ids that were released.
 * This is designed to be called:
 *   1. Before every seat read (lazy expiry)
 *   2. Before every hold/confirm operation
 *   3. Periodically via a sweep timer
 */
export async function expireStaleHolds() {
  const db = await getDb();
  const releasedSeats = [];

  // Use a transaction to atomically find and release expired holds
  const result = await db.transaction(async (tx) => {
    // Find all seats that are held but expired
    const expired = await tx.query(`
      UPDATE seats
      SET status = 'available',
          hold_id = NULL,
          hold_session_id = NULL,
          hold_expires_at = NULL
      WHERE status = 'held'
        AND hold_expires_at IS NOT NULL
        AND hold_expires_at <= NOW()
      RETURNING id, row_label, seat_number
    `);

    if (expired.rows.length > 0) {
      // Also update the holds table to mark those holds as expired
      // Get the distinct hold_ids for the expired seats
      // Since we already updated seats, we need to mark holds whose seats are all released
      await tx.query(`
        UPDATE holds
        SET status = 'expired'
        WHERE status = 'active'
          AND expires_at <= NOW()
      `);
    }

    return expired.rows;
  });

  if (result.length > 0) {
    // Broadcast each released seat
    for (const seat of result) {
      broadcast("seatUpdate", {
        id: seat.id,
        row_label: seat.row_label,
        seat_number: seat.seat_number,
        status: "available",
        hold_id: null,
        hold_session_id: null,
        hold_expires_at: null,
        booked_by: null,
      });
    }
  }

  return result;
}

let sweepInterval = null;

export function startExpirySweep(intervalMs = 1000) {
  if (sweepInterval) return;
  sweepInterval = setInterval(async () => {
    try {
      await expireStaleHolds();
    } catch (err) {
      console.error("Expiry sweep error:", err);
    }
  }, intervalMs);
}

export function stopExpirySweep() {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}
