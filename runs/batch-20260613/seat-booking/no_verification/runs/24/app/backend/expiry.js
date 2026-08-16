import { getDb } from "./db.js";
import { broadcast } from "./sse.js";

/**
 * Expire all stale holds.
 * Returns the list of seat ids that were released.
 * This function should be called:
 *   - Before reading seats
 *   - Before acquiring holds
 *   - Before confirming holds
 *   - Periodically via sweep
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
          hold_expires_at = NULL,
          session_id = NULL
      WHERE status = 'held'
        AND hold_expires_at IS NOT NULL
        AND hold_expires_at <= NOW()
      RETURNING id, row_label, seat_number
    `);

    if (expired.rows.length > 0) {
      // Also update the holds table
      await tx.query(`
        UPDATE holds
        SET status = 'expired'
        WHERE status = 'active'
          AND expires_at <= NOW()
      `);
    }

    return expired.rows;
  });

  // Broadcast released seats outside the transaction
  if (result.length > 0) {
    const seatUpdates = result.map((s) => ({
      id: s.id,
      row_label: s.row_label,
      seat_number: s.seat_number,
      status: "available",
      hold_id: null,
      hold_expires_at: null,
      session_id: null,
      booked_by: null,
    }));
    broadcast("seats-updated", seatUpdates);
  }

  return result.map((s) => s.id);
}

let sweepInterval = null;

export function startSweep(intervalMs = 1000) {
  if (sweepInterval) return;
  sweepInterval = setInterval(async () => {
    try {
      await expireStaleHolds();
    } catch (e) {
      console.error("Sweep error:", e);
    }
  }, intervalMs);
}

export function stopSweep() {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}
