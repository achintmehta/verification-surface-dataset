import { getDb } from "./db.js";
import { broadcast } from "./sse.js";

/**
 * Expire all holds that have passed their TTL.
 * Returns an array of seat objects that were released.
 */
export async function expireStaleHolds() {
  const db = await getDb();
  const released = [];

  // Find and release expired held seats in a single transaction
  const result = await db.query(`
    UPDATE seats
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
    WHERE status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at <= NOW()
    RETURNING id, row_label, seat_number
  `);

  if (result.rows.length > 0) {
    // Also mark the corresponding holds as expired
    const expiredSeatIds = result.rows.map((r) => r.id);

    await db.query(`
      UPDATE holds
      SET status = 'expired'
      WHERE status = 'active' AND expires_at <= NOW()
    `);

    for (const seat of result.rows) {
      released.push({
        id: seat.id,
        row_label: seat.row_label,
        seat_number: seat.seat_number,
        status: "available",
      });
    }

    // Broadcast released seats
    broadcast("seats-updated", released);
  }

  return released;
}

let sweepInterval = null;

export function startExpirySweep(intervalMs = 1000) {
  if (sweepInterval) return;
  sweepInterval = setInterval(async () => {
    try {
      await expireStaleHolds();
    } catch (e) {
      console.error("Expiry sweep error:", e);
    }
  }, intervalMs);
}

export function stopExpirySweep() {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}
