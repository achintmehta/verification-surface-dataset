import { broadcastSeatUpdate } from "./sse.js";

/**
 * @typedef {{id: number, row_label: string, seat_number: number, status: string, hold_id: string|null, hold_expires_at: string|null, booked_by: string|null}} Seat
 * @typedef {{id: number, row_label: string, seat_number: number, status: string, hold_id: string|null, hold_expires_at: string|null}} EffectiveSeat
 */

/**
 * Sweep expired holds: release any seat whose hold has expired,
 * update the holds table, and broadcast the changes.
 * @param {import("@electric-sql/pglite").PGlite} db
 * @returns {Promise<EffectiveSeat[]>}
 */
export async function sweepExpiredHolds(db) {
  // Find seats with expired holds
  const expiredSeats = await db.query(
    `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
     FROM seats
     WHERE status = 'held'
       AND hold_expires_at IS NOT NULL
       AND hold_expires_at <= NOW()`
  );

  if (expiredSeats.rows.length === 0) {
    return [];
  }

  const expiredSeatIds = expiredSeats.rows.map((s) => s.id);
  const expiredHoldIds = [
    ...new Set(
      expiredSeats.rows
        .map((s) => s.hold_id)
        .filter((h) => h !== null)
    ),
  ];

  // Release the seats
  await db.query(
    `UPDATE seats
     SET status = 'available', hold_id = NULL, hold_expires_at = NULL
     WHERE id = ANY($1::int[])
       AND status = 'held'
       AND hold_expires_at IS NOT NULL
       AND hold_expires_at <= NOW()`,
    [expiredSeatIds]
  );

  // Mark holds as expired
  if (expiredHoldIds.length > 0) {
    await db.query(
      `UPDATE holds
       SET status = 'expired'
       WHERE id = ANY($1::text[])
         AND status = 'active'`,
      [expiredHoldIds]
    );
  }

  // Build the released seat info for broadcasting
  const releasedSeats = expiredSeats.rows.map((s) => ({
    id: s.id,
    row_label: s.row_label,
    seat_number: s.seat_number,
    status: "available",
    hold_id: null,
    hold_expires_at: null,
  }));

  // Broadcast changes
  broadcastSeatUpdate(releasedSeats);

  return releasedSeats;
}

/**
 * Get the effective status of a seat: if it has an expired hold,
 * treat it as available.
 * @param {Seat} seat
 * @returns {EffectiveSeat}
 */
export function getEffectiveStatus(seat) {
  if (
    seat.status === "held" &&
    seat.hold_expires_at &&
    new Date(seat.hold_expires_at) <= new Date()
  ) {
    return {
      id: seat.id,
      row_label: seat.row_label,
      seat_number: seat.seat_number,
      status: "available",
      hold_id: null,
      hold_expires_at: null,
    };
  }

  return {
    id: seat.id,
    row_label: seat.row_label,
    seat_number: seat.seat_number,
    status: seat.status,
    hold_id: seat.hold_id,
    hold_expires_at: seat.hold_expires_at,
  };
}

/** @type {ReturnType<typeof setInterval> | null} */
let sweepInterval = null;

/**
 * Start a periodic sweep of expired holds.
 * @param {import("@electric-sql/pglite").PGlite} db
 * @param {number} [intervalMs=5000]
 */
export function startPeriodicSweep(db, intervalMs = 5000) {
  if (sweepInterval) return;
  sweepInterval = setInterval(() => {
    sweepExpiredHolds(db).catch((err) => {
      console.error("Error in periodic sweep:", err);
    });
  }, intervalMs);
}

export function stopPeriodicSweep() {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}
