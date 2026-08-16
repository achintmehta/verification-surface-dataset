const { getDb } = require("./db");
const { broadcast } = require("./sse");

/**
 * Expire all holds that have passed their TTL.
 * Each hold is expired atomically in its own transaction.
 * Returns array of seats that were released.
 */
async function expireStaleHolds() {
  const db = await getDb();
  const allReleasedSeats = [];

  // Find expired holds that are still active
  const expiredHolds = await db.query(
    `SELECT id, seat_ids, session_id FROM holds
     WHERE status = 'active' AND expires_at <= NOW()`
  );

  for (const hold of expiredHolds.rows) {
    try {
      const result = await db.transaction(async (tx) => {
        // Re-check the hold status under transaction
        const holdCheck = await tx.query(
          `SELECT id, status FROM holds WHERE id = $1 FOR UPDATE`,
          [hold.id]
        );

        if (holdCheck.rows.length === 0 || holdCheck.rows[0].status !== "active") {
          return { seats: [] };
        }

        // Release the seats
        const updated = await tx.query(
          `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
           WHERE hold_id = $1 AND status = 'held'
           RETURNING id, row_label, seat_number`,
          [hold.id]
        );

        // Mark the hold as expired
        await tx.query(
          `UPDATE holds SET status = 'expired' WHERE id = $1`,
          [hold.id]
        );

        return { seats: updated.rows };
      });

      if (result.seats.length > 0) {
        allReleasedSeats.push(...result.seats);
      }
    } catch (e) {
      console.error(`Error expiring hold ${hold.id}:`, e);
    }
  }

  // Broadcast all released seats in one batch
  if (allReleasedSeats.length > 0) {
    broadcast("seats-updated", {
      seats: allReleasedSeats.map((s) => ({
        id: s.id,
        row_label: s.row_label,
        seat_number: s.seat_number,
        status: "available",
        hold_id: null,
        hold_expires_at: null,
        session_id: null,
        booked_by: null,
      })),
      reason: "expired",
    });
  }

  return allReleasedSeats;
}

let sweepInterval = null;

function startPeriodicSweep(intervalMs = 1000) {
  if (sweepInterval) return;
  sweepInterval = setInterval(async () => {
    try {
      await expireStaleHolds();
    } catch (e) {
      console.error("Sweep error:", e);
    }
  }, intervalMs);
}

function stopPeriodicSweep() {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}

module.exports = { expireStaleHolds, startPeriodicSweep, stopPeriodicSweep };
