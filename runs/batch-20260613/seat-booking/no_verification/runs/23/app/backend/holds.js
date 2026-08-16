const { getDb } = require("./db");
const { broadcast } = require("./sse");
const { expireHolds } = require("./seats");
const { v4: uuidv4 } = require("uuid");

const HOLD_TTL_SECONDS = 60; // 60 second hold TTL

/**
 * Atomically acquire a hold on the requested seats.
 * All-or-nothing: if any seat is unavailable, none are held.
 *
 * @param {number[]} seatIds - array of seat IDs to hold
 * @param {string} sessionId - client session identifier
 * @returns {{ hold, seats }} on success
 * @throws {{ status, conflicting }} on conflict
 */
async function createHold(seatIds, sessionId) {
  if (!seatIds || seatIds.length === 0) {
    throw { status: 400, message: "seatIds is required and must be non-empty" };
  }
  if (!sessionId) {
    throw { status: 400, message: "sessionId is required" };
  }

  const db = await getDb();

  // Expire stale holds first
  await expireHolds();

  const holdId = uuidv4();
  const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

  await db.exec("BEGIN");
  try {
    // Lock the requested seats with FOR UPDATE to prevent concurrent modifications
    // We order by id to prevent deadlocks
    const sortedIds = [...seatIds].sort((a, b) => a - b);
    const placeholders = sortedIds.map((_, i) => `$${i + 1}`).join(", ");

    const lockResult = await db.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
       FROM seats
       WHERE id IN (${placeholders})
       FOR UPDATE
       ORDER BY id`,
      sortedIds
    );

    if (lockResult.rows.length !== sortedIds.length) {
      await db.exec("ROLLBACK");
      throw { status: 400, message: "One or more seat IDs are invalid" };
    }

    // Check if any seats are unavailable (not available)
    // Also treat expired holds as available
    const conflicting = [];
    for (const seat of lockResult.rows) {
      const isExpired =
        seat.status === "held" &&
        seat.hold_expires_at &&
        new Date(seat.hold_expires_at) <= new Date();

      if (seat.status === "held" && !isExpired) {
        conflicting.push({
          id: seat.id,
          row_label: seat.row_label,
          seat_number: seat.seat_number,
          status: seat.status,
        });
      } else if (seat.status === "booked") {
        conflicting.push({
          id: seat.id,
          row_label: seat.row_label,
          seat_number: seat.seat_number,
          status: seat.status,
        });
      }
      // If expired, we'll release it in the update below
    }

    if (conflicting.length > 0) {
      await db.exec("ROLLBACK");
      throw { status: 409, conflicting };
    }

    // Release any expired holds on these seats first (within the lock)
    await db.query(
      `UPDATE seats
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL
       WHERE id IN (${placeholders}) AND status = 'held' AND hold_expires_at <= NOW()`,
      sortedIds
    );

    // Mark expired holds in the holds table too
    await db.query(`
      UPDATE holds SET status = 'expired'
      WHERE status = 'active' AND expires_at <= NOW()
    `);

    // Now acquire the hold on all seats
    const updateResult = await db.query(
      `UPDATE seats
       SET status = 'held',
           hold_id = $${sortedIds.length + 1},
           hold_expires_at = $${sortedIds.length + 2}
       WHERE id IN (${placeholders}) AND status = 'available'
       RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
      [...sortedIds, holdId, expiresAt.toISOString()]
    );

    if (updateResult.rows.length !== sortedIds.length) {
      // This shouldn't happen given the checks above, but safety net
      await db.exec("ROLLBACK");
      throw {
        status: 409,
        message: "Failed to acquire all seats",
        conflicting: [],
      };
    }

    // Insert hold record
    await db.query(
      `INSERT INTO holds (id, session_id, seat_ids, expires_at, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [holdId, sessionId, sortedIds, expiresAt.toISOString()]
    );

    await db.exec("COMMIT");

    // Broadcast the seat status changes
    broadcast(updateResult.rows);

    return {
      hold: {
        id: holdId,
        sessionId,
        seatIds: sortedIds,
        expiresAt: expiresAt.toISOString(),
        ttlSeconds: HOLD_TTL_SECONDS,
        status: "active",
      },
      seats: updateResult.rows,
    };
  } catch (err) {
    // If it's our own error, rethrow
    if (err.status) {
      throw err;
    }
    // Otherwise rollback and throw
    try {
      await db.exec("ROLLBACK");
    } catch {
      // ignore rollback error
    }
    throw err;
  }
}

/**
 * Confirm a hold, booking the seats permanently.
 * Idempotent: confirming an already-confirmed hold returns the same result.
 *
 * @param {string} holdId
 * @returns {{ hold, seats }} on success
 * @throws on expired/unknown hold
 */
async function confirmHold(holdId) {
  if (!holdId) {
    throw { status: 400, message: "holdId is required" };
  }

  const db = await getDb();

  // Expire stale holds first
  await expireHolds();

  await db.exec("BEGIN");
  try {
    // Lock and fetch the hold
    const holdResult = await db.query(
      `SELECT id, session_id, seat_ids, expires_at, status, confirmed_at
       FROM holds
       WHERE id = $1
       FOR UPDATE`,
      [holdId]
    );

    if (holdResult.rows.length === 0) {
      await db.exec("ROLLBACK");
      throw { status: 404, message: "Hold not found" };
    }

    const hold = holdResult.rows[0];

    // Idempotent: if already confirmed, return the booking
    if (hold.status === "confirmed") {
      const seatIds = hold.seat_ids;
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
      const seatsResult = await db.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
         FROM seats
         WHERE id IN (${placeholders})
         ORDER BY id`,
        seatIds
      );

      await db.exec("COMMIT");

      return {
        hold: {
          id: hold.id,
          sessionId: hold.session_id,
          seatIds: hold.seat_ids,
          expiresAt: hold.expires_at,
          status: "confirmed",
          confirmedAt: hold.confirmed_at,
        },
        seats: seatsResult.rows,
        alreadyConfirmed: true,
      };
    }

    // Check if hold is expired or released
    if (hold.status === "expired" || hold.status === "released") {
      await db.exec("ROLLBACK");
      throw {
        status: 410,
        message: `Hold has been ${hold.status}`,
      };
    }

    // Check if the hold's TTL has passed (even if status is still 'active')
    if (new Date(hold.expires_at) <= new Date()) {
      // Mark it expired
      await db.query(
        `UPDATE holds SET status = 'expired' WHERE id = $1`,
        [holdId]
      );
      // Release seats
      const seatIds = hold.seat_ids;
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
      const releasedSeats = await db.query(
        `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL
         WHERE id IN (${placeholders}) AND hold_id = $${seatIds.length + 1}
         RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
        [...seatIds, holdId]
      );

      await db.exec("COMMIT");

      if (releasedSeats.rows.length > 0) {
        broadcast(releasedSeats.rows);
      }

      throw { status: 410, message: "Hold has expired" };
    }

    // Verify the hold still owns all its seats
    const seatIds = hold.seat_ids;
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");

    const seatsCheck = await db.query(
      `SELECT id, status, hold_id
       FROM seats
       WHERE id IN (${placeholders})
       FOR UPDATE
       ORDER BY id`,
      seatIds
    );

    // Verify every seat is still held by this hold
    const ownedSeats = seatsCheck.rows.filter(
      (s) => s.status === "held" && s.hold_id === holdId
    );

    if (ownedSeats.length !== seatIds.length) {
      // Something went wrong - the hold doesn't own all its seats
      await db.query(
        `UPDATE holds SET status = 'expired' WHERE id = $1`,
        [holdId]
      );
      await db.exec("COMMIT");
      throw {
        status: 409,
        message: "Hold no longer owns all its seats",
      };
    }

    // Book the seats
    const bookResult = await db.query(
      `UPDATE seats
       SET status = 'booked',
           booked_by = $${seatIds.length + 1},
           hold_expires_at = NULL
       WHERE id IN (${placeholders}) AND hold_id = $${seatIds.length + 2}
       RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
      [...seatIds, hold.session_id, holdId]
    );

    // Mark hold as confirmed
    await db.query(
      `UPDATE holds SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1`,
      [holdId]
    );

    await db.exec("COMMIT");

    // Broadcast the booking
    broadcast(bookResult.rows);

    return {
      hold: {
        id: hold.id,
        sessionId: hold.session_id,
        seatIds: hold.seat_ids,
        expiresAt: hold.expires_at,
        status: "confirmed",
      },
      seats: bookResult.rows,
      alreadyConfirmed: false,
    };
  } catch (err) {
    if (err.status) {
      throw err;
    }
    try {
      await db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * Release a hold early, returning its seats to available.
 *
 * @param {string} holdId
 * @returns {{ released: seat[] }}
 */
async function releaseHold(holdId) {
  if (!holdId) {
    throw { status: 400, message: "holdId is required" };
  }

  const db = await getDb();

  await db.exec("BEGIN");
  try {
    const holdResult = await db.query(
      `SELECT id, session_id, seat_ids, status
       FROM holds
       WHERE id = $1
       FOR UPDATE`,
      [holdId]
    );

    if (holdResult.rows.length === 0) {
      await db.exec("ROLLBACK");
      throw { status: 404, message: "Hold not found" };
    }

    const hold = holdResult.rows[0];

    if (hold.status === "confirmed") {
      await db.exec("ROLLBACK");
      throw {
        status: 400,
        message: "Cannot release a confirmed hold",
      };
    }

    if (hold.status === "released") {
      await db.exec("ROLLBACK");
      // Idempotent release
      return { released: [] };
    }

    // Release the seats
    const seatIds = hold.seat_ids;
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");

    const releasedSeats = await db.query(
      `UPDATE seats
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL
       WHERE id IN (${placeholders}) AND hold_id = $${seatIds.length + 1}
       RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
      [...seatIds, holdId]
    );

    // Mark hold as released
    await db.query(
      `UPDATE holds SET status = 'released' WHERE id = $1`,
      [holdId]
    );

    await db.exec("COMMIT");

    if (releasedSeats.rows.length > 0) {
      broadcast(releasedSeats.rows);
    }

    return { released: releasedSeats.rows };
  } catch (err) {
    if (err.status) throw err;
    try {
      await db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw err;
  }
}

module.exports = { createHold, confirmHold, releaseHold, HOLD_TTL_SECONDS };
