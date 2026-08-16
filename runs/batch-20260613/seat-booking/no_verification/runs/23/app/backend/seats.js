const { getDb } = require("./db");
const { broadcast } = require("./sse");

/**
 * Expire any holds whose TTL has passed.
 * Returns the list of seat objects that were released.
 * This is called lazily before reads and before hold/confirm operations,
 * and also periodically by the sweep timer.
 */
async function expireHolds() {
  const db = await getDb();

  // In a single transaction: find expired holds, release their seats, mark holds expired
  const released = [];

  await db.exec("BEGIN");
  try {
    // Find seats that are held but expired
    const expiredSeats = await db.query(`
      UPDATE seats
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at <= NOW()
      RETURNING id, row_label, seat_number, status
    `);

    if (expiredSeats.rows.length > 0) {
      // Collect the distinct hold_ids that were expired
      // We need to mark the holds table too
      // Since we already cleared hold_id from seats, we need to find from holds table
      await db.query(`
        UPDATE holds
        SET status = 'expired'
        WHERE status = 'active' AND expires_at <= NOW()
      `);

      for (const seat of expiredSeats.rows) {
        released.push({
          id: seat.id,
          row_label: seat.row_label,
          seat_number: seat.seat_number,
          status: "available",
          hold_id: null,
          hold_expires_at: null,
          booked_by: null,
        });
      }
    }

    await db.exec("COMMIT");
  } catch (err) {
    await db.exec("ROLLBACK");
    throw err;
  }

  if (released.length > 0) {
    broadcast(released);
  }

  return released;
}

/**
 * Get all seats with effective status (expired holds shown as available).
 */
async function getAllSeats() {
  // First expire any stale holds
  await expireHolds();

  const db = await getDb();
  const result = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
    FROM seats
    ORDER BY row_label, seat_number
  `);

  // Map effective status: if a held seat is expired (shouldn't happen after expireHolds, but safety)
  return result.rows.map((seat) => {
    if (
      seat.status === "held" &&
      seat.hold_expires_at &&
      new Date(seat.hold_expires_at) <= new Date()
    ) {
      return {
        ...seat,
        status: "available",
        hold_id: null,
        hold_expires_at: null,
      };
    }
    return seat;
  });
}

module.exports = { expireHolds, getAllSeats };
