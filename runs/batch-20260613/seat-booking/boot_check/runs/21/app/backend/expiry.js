import { getDb } from "./db.js";
import { broadcast } from "./sse.js";

/**
 * Expire all stale holds, returning any seats freed to available.
 * Returns array of seat objects that were released.
 */
export async function expireStaleHolds() {
  const db = await getDb();
  const released = [];

  // Use a transaction to atomically expire stale holds and free their seats
  await db.transaction(async (tx) => {
    // Find all holds that are active but expired
    const expiredHolds = await tx.query(
      `UPDATE holds
       SET status = 'expired'
       WHERE status = 'active' AND expires_at <= NOW()
       RETURNING id, seat_ids`
    );

    if (expiredHolds.rows.length === 0) return;

    // Collect all seat IDs from expired holds
    const allSeatIds = [];
    for (const hold of expiredHolds.rows) {
      if (hold.seat_ids) {
        allSeatIds.push(...hold.seat_ids);
      }
    }

    if (allSeatIds.length === 0) return;

    // Release those seats
    const updatedSeats = await tx.query(
      `UPDATE seats
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
       WHERE id = ANY($1) AND status = 'held'
       RETURNING id, row_label, seat_number, status`,
      [allSeatIds]
    );

    released.push(...updatedSeats.rows);
  });

  // Broadcast releases outside transaction
  for (const seat of released) {
    broadcast("seat-update", {
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

  return released;
}
