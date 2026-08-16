/**
 * Hold-expiry logic.
 * Provides lazy (on-demand) expiry that can be called before reads and
 * a periodic sweep that runs on a timer.
 */

import { broadcast } from "./sse.js";

/**
 * Expire all stale holds and return the seat ids that were released.
 * This is idempotent and safe to call frequently.
 * @param {import('@electric-sql/pglite').PGlite} db
 * @returns {Promise<Array<{id: number, row_label: string, seat_number: number}>>}
 */
export async function expireStaleHolds(db) {
  // Within a transaction:
  // 1. Find seats whose hold has expired
  // 2. Reset those seats to available
  // 3. Mark the corresponding hold records as expired
  // 4. Return released seat info

  const released = await db.transaction(async (/** @type {any} */ tx) => {
    // Find expired held seats
    const { rows: expiredSeats } = await tx.query(`
      UPDATE seats
      SET status = 'available',
          hold_id = NULL,
          hold_expires_at = NULL,
          session_id = NULL
      WHERE status = 'held'
        AND hold_expires_at IS NOT NULL
        AND hold_expires_at <= NOW()
      RETURNING id, row_label, seat_number, hold_id
    `);

    if (expiredSeats.length === 0) return [];

    // Collect unique hold_ids
    const holdIds = [...new Set(expiredSeats.map((/** @type {any} */ s) => s.hold_id))];
    for (const holdId of holdIds) {
      await tx.query(`
        UPDATE holds SET status = 'expired'
        WHERE id = $1 AND status = 'active'
      `, [holdId]);
    }

    return expiredSeats.map((/** @type {any} */ s) => ({
      id: s.id,
      row_label: s.row_label,
      seat_number: s.seat_number,
    }));
  });

  // Broadcast releases outside the transaction
  if (released.length > 0) {
    broadcast("seats-updated", {
      type: "expired",
      seats: released.map((/** @type {any} */ s) => ({
        id: s.id,
        row_label: s.row_label,
        seat_number: s.seat_number,
        status: "available",
      })),
    });
  }

  return released;
}

/**
 * Start a periodic sweep that expires stale holds.
 * @param {import('@electric-sql/pglite').PGlite} db
 * @param {number} [intervalMs=2000]
 * @returns {{ stop: () => void }}
 */
export function startExpirySweep(db, intervalMs = 2000) {
  const timer = setInterval(async () => {
    try {
      await expireStaleHolds(db);
    } catch (err) {
      console.error("Expiry sweep error:", err);
    }
  }, intervalMs);

  return {
    stop: () => clearInterval(timer),
  };
}
