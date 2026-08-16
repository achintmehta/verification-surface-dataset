import { getDb } from "./db.js";
import { broadcast } from "./sse.js";

/**
 * Sweep expired holds: release any seats whose hold has expired.
 * Returns the list of seat ids that were released.
 */
export async function sweepExpiredHolds() {
  const db = await getDb();
  const released = [];

  // Use a transaction to atomically find and release expired seats
  await db.exec("BEGIN");

  try {
    // Find seats with expired holds
    const expiredSeats = await db.query(`
      SELECT s.id, s.row_label, s.seat_number, s.hold_id
      FROM seats s
      WHERE s.status = 'held'
        AND s.hold_expires_at IS NOT NULL
        AND s.hold_expires_at <= NOW()
      FOR UPDATE
    `);

    if (expiredSeats.rows.length > 0) {
      const seatIds = expiredSeats.rows.map((r) => r.id);
      const holdIds = [...new Set(expiredSeats.rows.map((r) => r.hold_id).filter(Boolean))];

      // Release the seats
      await db.query(
        `UPDATE seats
         SET status = 'available',
             hold_id = NULL,
             hold_expires_at = NULL,
             session_id = NULL
         WHERE id = ANY($1::int[])
           AND status = 'held'
           AND hold_expires_at <= NOW()`,
        [seatIds]
      );

      // Mark holds as expired
      if (holdIds.length > 0) {
        await db.query(
          `UPDATE holds
           SET status = 'expired'
           WHERE id = ANY($1::text[])
             AND status = 'active'`,
          [holdIds]
        );
      }

      for (const seat of expiredSeats.rows) {
        released.push({
          id: seat.id,
          rowLabel: seat.row_label,
          seatNumber: seat.seat_number,
          status: "available",
          holdId: null,
          holdExpiresAt: null,
          sessionId: null,
          bookedBy: null,
        });
      }
    }

    await db.exec("COMMIT");
  } catch (err) {
    await db.exec("ROLLBACK");
    throw err;
  }

  // Broadcast releases outside the transaction
  if (released.length > 0) {
    broadcast("seats-updated", released);
  }

  return released;
}

let sweepInterval = null;

export function startPeriodicSweep(intervalMs = 1000) {
  if (sweepInterval) return;
  sweepInterval = setInterval(async () => {
    try {
      await sweepExpiredHolds();
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
