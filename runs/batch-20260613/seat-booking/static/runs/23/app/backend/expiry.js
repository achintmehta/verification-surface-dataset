import { broadcastSeatUpdates } from "./sse.js";

/**
 * Release all expired holds and return the affected seat IDs.
 * @param {import('@electric-sql/pglite').PGlite} db
 * @returns {Promise<number[]>}
 */
export async function releaseExpiredHolds(db) {
  // Find seats with expired holds and release them
  const expiredSeats = await db.query(
    `UPDATE seats
     SET status = 'available',
         hold_id = NULL,
         hold_expires_at = NULL
     WHERE status = 'held'
       AND hold_expires_at IS NOT NULL
       AND hold_expires_at <= NOW()
     RETURNING id, row_label, seat_number, hold_id`
  );

  if (expiredSeats.rows.length === 0) {
    return [];
  }

  // Collect unique hold IDs to mark as expired
  const holdIds = [...new Set(expiredSeats.rows.map((r) => r.hold_id))];

  // Mark holds as expired
  if (holdIds.length > 0) {
    await db.query(
      `UPDATE holds SET status = 'expired' WHERE id = ANY($1::text[]) AND status = 'active'`,
      [holdIds]
    );
  }

  // Broadcast updates
  const updates = expiredSeats.rows.map((row) => ({
    seatId: row.id,
    rowLabel: row.row_label,
    seatNumber: row.seat_number,
    status: "available",
    holdId: null,
    holdExpiresAt: null,
  }));

  broadcastSeatUpdates(updates);

  return expiredSeats.rows.map((r) => r.id);
}

/**
 * Start a periodic sweep that releases expired holds.
 * @param {import('@electric-sql/pglite').PGlite} db
 * @param {number} intervalMs
 * @returns {ReturnType<typeof setInterval>}
 */
export function startExpirySweep(db, intervalMs = 1000) {
  return setInterval(async () => {
    try {
      await releaseExpiredHolds(db);
    } catch (err) {
      console.error("Expiry sweep error:", err);
    }
  }, intervalMs);
}
