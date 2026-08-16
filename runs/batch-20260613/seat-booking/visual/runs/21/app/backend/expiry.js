import { getDb } from "./db.js";
import { broadcast } from "./sse.js";

/**
 * Expire all stale holds: update seats back to available and mark holds as expired.
 * Returns the list of seat IDs that were released.
 */
export async function expireStaleHolds() {
  const db = await getDb();

  // Use a transaction so we atomically find and release expired holds
  const releasedSeats = [];

  await db.transaction(async (tx) => {
    // Find all seats that are held but whose hold has expired
    const expiredSeats = await tx.query(`
      SELECT s.id, s.row_label, s.seat_number, s.hold_id
      FROM seats s
      WHERE s.status = 'held'
        AND s.hold_expires_at IS NOT NULL
        AND s.hold_expires_at <= NOW()
    `);

    if (expiredSeats.rows.length === 0) return;

    const seatIds = expiredSeats.rows.map((r) => r.id);
    const holdIds = [...new Set(expiredSeats.rows.map((r) => r.hold_id).filter(Boolean))];

    // Release the seats
    if (seatIds.length > 0) {
      // Build parameterized IN clause
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
      await tx.query(
        `UPDATE seats 
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
         WHERE id IN (${placeholders})`,
        seatIds
      );
    }

    // Mark holds as expired
    if (holdIds.length > 0) {
      const placeholders = holdIds.map((_, i) => `$${i + 1}`).join(", ");
      await tx.query(
        `UPDATE holds SET status = 'expired' WHERE id IN (${placeholders}) AND status = 'active'`,
        holdIds
      );
    }

    for (const seat of expiredSeats.rows) {
      releasedSeats.push({
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
  });

  // Broadcast releases outside transaction
  if (releasedSeats.length > 0) {
    broadcast("seatUpdate", releasedSeats);
  }

  return releasedSeats;
}

let sweepInterval;

export function startPeriodicSweep(intervalMs = 1000) {
  sweepInterval = setInterval(async () => {
    try {
      await expireStaleHolds();
    } catch (e) {
      console.error("Sweep error:", e);
    }
  }, intervalMs);
}

export function stopPeriodicSweep() {
  if (sweepInterval) clearInterval(sweepInterval);
}
