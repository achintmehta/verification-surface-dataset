// Expiry logic: lazy sweep of expired holds
import { getDb } from "./db.js";
import { broadcast } from "./sse.js";

/**
 * Expire all holds whose TTL has elapsed.
 * Returns the list of seat ids that were released.
 */
export async function expireStaleHolds() {
  const db = await getDb();
  const released = [];

  // Find expired holds that are still active
  const expiredHolds = await db.query(`
    UPDATE holds
    SET status = 'expired'
    WHERE status = 'active' AND expires_at <= NOW()
    RETURNING id, seat_ids
  `);

  if (expiredHolds.rows.length === 0) return released;

  // Release the seats belonging to those holds
  for (const hold of expiredHolds.rows) {
    const seatIds = hold.seat_ids;
    if (seatIds && seatIds.length > 0) {
      // Only release seats still held by this hold (not yet booked by someone else)
      const result = await db.query(`
        UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
        WHERE id = ANY($1) AND status = 'held' AND hold_id = $2
        RETURNING id, row_label, seat_number, status
      `, [seatIds, hold.id]);

      for (const seat of result.rows) {
        released.push(seat);
      }
    }
  }

  // Broadcast released seats
  if (released.length > 0) {
    broadcast("seat-update", released.map(s => ({
      id: s.id,
      row_label: s.row_label,
      seat_number: s.seat_number,
      status: "available",
      hold_id: null,
      hold_expires_at: null,
      session_id: null,
      booked_by: null
    })));
  }

  return released;
}

let sweepInterval;

export function startSweep(intervalMs = 1000) {
  sweepInterval = setInterval(async () => {
    try {
      await expireStaleHolds();
    } catch (err) {
      console.error("Sweep error:", err);
    }
  }, intervalMs);
}

export function stopSweep() {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}
