import { getDb } from "./db.js";
import { broadcast } from "./sse.js";
import crypto from "crypto";

/** Hold TTL in seconds */
const HOLD_TTL_SECONDS = 60;

/**
 * Expire stale holds. Must be called inside or outside a transaction.
 * Returns the list of seat ids that were released.
 * @param {import("@electric-sql/pglite").PGlite | import("@electric-sql/pglite").Transaction} tx
 * @returns {Promise<Array<{id: number, row_label: string, seat_number: number}>>}
 */
async function expireStaleHolds(tx) {
  // Find seats with expired holds
  const expired = await tx.query(`
    UPDATE seats
    SET status = 'available',
        hold_id = NULL,
        hold_expires_at = NULL,
        session_id = NULL
    WHERE status = 'held'
      AND hold_expires_at IS NOT NULL
      AND hold_expires_at <= NOW()
    RETURNING id, row_label, seat_number
  `);

  if (expired.rows.length > 0) {
    // Also update the holds table
    await tx.query(`
      UPDATE holds
      SET status = 'expired'
      WHERE status = 'active'
        AND expires_at <= NOW()
    `);
  }

  return expired.rows;
}

/**
 * Broadcast releases for expired seats.
 * @param {Array<{id: number, row_label: string, seat_number: number}>} releasedSeats
 */
function broadcastReleases(releasedSeats) {
  for (const seat of releasedSeats) {
    broadcast("seat-update", {
      seatId: seat.id,
      row_label: seat.row_label,
      seat_number: seat.seat_number,
      status: "available",
      holdId: null,
      holdExpiresAt: null,
      sessionId: null,
    });
  }
}

/**
 * Get all seats with effective status (expired holds shown as available).
 * @returns {Promise<Array<object>>}
 */
export async function getAllSeats() {
  const db = await getDb();

  // Expire stale holds first
  const released = await expireStaleHolds(db);
  broadcastReleases(released);

  const result = await db.query(`
    SELECT id, row_label, seat_number, status,
           hold_id, hold_expires_at, session_id, booked_by
    FROM seats
    ORDER BY row_label, seat_number
  `);

  return result.rows;
}

/**
 * Create a hold on the requested seats.
 * All-or-nothing: if any seat is unavailable, none are held.
 * @param {number[]} seatIds
 * @param {string} sessionId
 * @returns {Promise<{success: true, hold: object, seats: object[]} | {success: false, conflicting: object[]}>}
 */
export async function createHold(seatIds, sessionId) {
  const db = await getDb();
  const holdId = crypto.randomUUID();

  /** @type {{success: true, hold: object, seats: object[]} | {success: false, conflicting: object[]}} */
  let result;

  await db.transaction(async (tx) => {
    // 1. Expire stale holds first within this transaction
    const released = await expireStaleHolds(tx);
    // We'll broadcast releases after commit

    // 2. Check requested seats
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
    const seatCheck = await tx.query(
      `SELECT id, row_label, seat_number, status, hold_id, session_id
       FROM seats
       WHERE id IN (${placeholders})
       FOR UPDATE`,
      seatIds
    );

    if (seatCheck.rows.length !== seatIds.length) {
      const foundIds = new Set(seatCheck.rows.map((r) => r.id));
      const missing = seatIds.filter((id) => !foundIds.has(id));
      result = {
        success: false,
        conflicting: missing.map((id) => ({ seatId: id, reason: "not_found" })),
        _released: released,
      };
      return;
    }

    // 3. Check all seats are available
    const unavailable = seatCheck.rows.filter((s) => s.status !== "available");
    if (unavailable.length > 0) {
      result = {
        success: false,
        conflicting: unavailable.map((s) => ({
          seatId: s.id,
          row_label: s.row_label,
          seat_number: s.seat_number,
          status: s.status,
          reason: s.status === "held" ? "held_by_another" : "already_booked",
        })),
        _released: released,
      };
      return;
    }

    // 4. Atomically mark seats as held
    const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();
    const updateResult = await tx.query(
      `UPDATE seats
       SET status = 'held',
           hold_id = $${seatIds.length + 1},
           hold_expires_at = $${seatIds.length + 2}::timestamptz,
           session_id = $${seatIds.length + 3}
       WHERE id IN (${placeholders})
         AND status = 'available'
       RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, session_id`,
      [...seatIds, holdId, expiresAt, sessionId]
    );

    if (updateResult.rows.length !== seatIds.length) {
      // Race condition - should not happen due to FOR UPDATE, but be safe
      // Rollback happens automatically via throw
      throw new Error("Concurrent modification detected");
    }

    // 5. Create the hold record
    await tx.query(
      `INSERT INTO holds (id, session_id, seat_ids, status, expires_at)
       VALUES ($1, $2, $3, 'active', $4::timestamptz)`,
      [holdId, sessionId, seatIds, expiresAt]
    );

    result = {
      success: true,
      hold: {
        holdId,
        sessionId,
        seatIds,
        expiresAt,
      },
      seats: updateResult.rows,
      _released: released,
    };
  });

  // @ts-ignore - result is always assigned in the transaction
  if (result._released) {
    // @ts-ignore
    broadcastReleases(result._released);
    // @ts-ignore
    delete result._released;
  }

  // @ts-ignore
  if (result.success) {
    // @ts-ignore
    for (const seat of result.seats) {
      broadcast("seat-update", {
        seatId: seat.id,
        row_label: seat.row_label,
        seat_number: seat.seat_number,
        status: "held",
        holdId: seat.hold_id,
        holdExpiresAt: seat.hold_expires_at,
        sessionId: seat.session_id,
      });
    }
  }

  // @ts-ignore
  return result;
}

/**
 * Confirm a hold, booking the seats permanently.
 * Idempotent: confirming an already-confirmed hold returns the same booking.
 * @param {string} holdId
 * @param {string} sessionId
 * @returns {Promise<{success: true, seats: object[]} | {success: false, reason: string, statusCode: number}>}
 */
export async function confirmHold(holdId, sessionId) {
  const db = await getDb();

  /** @type {any} */
  let result;

  await db.transaction(async (tx) => {
    // 1. Expire stale holds first
    const released = await expireStaleHolds(tx);

    // 2. Find the hold
    const holdResult = await tx.query(
      `SELECT id, session_id, seat_ids, status, expires_at, confirmed_at
       FROM holds
       WHERE id = $1`,
      [holdId]
    );

    if (holdResult.rows.length === 0) {
      result = { success: false, reason: "Hold not found", statusCode: 404, _released: released };
      return;
    }

    const hold = holdResult.rows[0];

    // 3. Check ownership
    if (hold.session_id !== sessionId) {
      result = { success: false, reason: "Hold belongs to a different session", statusCode: 403, _released: released };
      return;
    }

    // 4. Idempotent: if already confirmed, return the booked seats
    if (hold.status === "confirmed") {
      const seatIds = hold.seat_ids;
      const placeholders = seatIds.map((/** @type {any} */ _, /** @type {number} */ i) => `$${i + 1}`).join(", ");
      const seats = await tx.query(
        `SELECT id, row_label, seat_number, status, booked_by
         FROM seats WHERE id IN (${placeholders})`,
        seatIds
      );
      result = { success: true, seats: seats.rows, alreadyConfirmed: true, _released: released };
      return;
    }

    // 5. Check if expired or released
    if (hold.status === "expired" || hold.status === "released") {
      result = {
        success: false,
        reason: `Hold has been ${hold.status}`,
        statusCode: 410,
        _released: released,
      };
      return;
    }

    // 6. Check TTL
    if (new Date(hold.expires_at) <= new Date()) {
      // Mark as expired
      await tx.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [holdId]);
      // Release seats
      const seatIds = hold.seat_ids;
      const placeholders = seatIds.map((/** @type {any} */ _, /** @type {number} */ i) => `$${i + 1}`).join(", ");
      const releasedSeats = await tx.query(
        `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
         WHERE id IN (${placeholders}) AND hold_id = $${seatIds.length + 1}
         RETURNING id, row_label, seat_number`,
        [...seatIds, holdId]
      );
      result = {
        success: false,
        reason: "Hold has expired",
        statusCode: 410,
        _released: [...released, ...releasedSeats.rows],
      };
      return;
    }

    // 7. Book the seats
    const seatIds = hold.seat_ids;
    const placeholders = seatIds.map((/** @type {any} */ _, /** @type {number} */ i) => `$${i + 1}`).join(", ");

    const bookResult = await tx.query(
      `UPDATE seats
       SET status = 'booked',
           booked_by = $${seatIds.length + 1},
           hold_id = NULL,
           hold_expires_at = NULL
       WHERE id IN (${placeholders})
         AND status = 'held'
         AND hold_id = $${seatIds.length + 2}
       RETURNING id, row_label, seat_number, status, booked_by, session_id`,
      [...seatIds, sessionId, holdId]
    );

    if (bookResult.rows.length !== seatIds.length) {
      throw new Error("Failed to book all seats - concurrent modification");
    }

    // 8. Update hold status
    await tx.query(
      `UPDATE holds SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1`,
      [holdId]
    );

    result = {
      success: true,
      seats: bookResult.rows,
      alreadyConfirmed: false,
      _released: released,
    };
  });

  // Broadcast releases from expiry
  if (result._released) {
    broadcastReleases(result._released);
    delete result._released;
  }

  // Broadcast booked seats
  if (result.success && !result.alreadyConfirmed) {
    for (const seat of result.seats) {
      broadcast("seat-update", {
        seatId: seat.id,
        row_label: seat.row_label,
        seat_number: seat.seat_number,
        status: "booked",
        holdId: null,
        holdExpiresAt: null,
        sessionId: seat.session_id,
        bookedBy: seat.booked_by,
      });
    }
  }

  return result;
}

/**
 * Release a hold early, returning seats to available.
 * @param {string} holdId
 * @param {string} sessionId
 * @returns {Promise<{success: true, seats: object[]} | {success: false, reason: string, statusCode: number}>}
 */
export async function releaseHold(holdId, sessionId) {
  const db = await getDb();

  /** @type {any} */
  let result;

  await db.transaction(async (tx) => {
    // Expire stale holds first
    const released = await expireStaleHolds(tx);

    // Find the hold
    const holdResult = await tx.query(
      `SELECT id, session_id, seat_ids, status FROM holds WHERE id = $1`,
      [holdId]
    );

    if (holdResult.rows.length === 0) {
      result = { success: false, reason: "Hold not found", statusCode: 404, _released: released };
      return;
    }

    const hold = holdResult.rows[0];

    if (hold.session_id !== sessionId) {
      result = { success: false, reason: "Hold belongs to a different session", statusCode: 403, _released: released };
      return;
    }

    if (hold.status !== "active") {
      result = {
        success: false,
        reason: `Hold is ${hold.status}, cannot release`,
        statusCode: 410,
        _released: released,
      };
      return;
    }

    // Release seats
    const seatIds = hold.seat_ids;
    const placeholders = seatIds.map((/** @type {any} */ _, /** @type {number} */ i) => `$${i + 1}`).join(", ");
    const releasedSeats = await tx.query(
      `UPDATE seats
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
       WHERE id IN (${placeholders}) AND hold_id = $${seatIds.length + 1}
       RETURNING id, row_label, seat_number`,
      [...seatIds, holdId]
    );

    // Mark hold as released
    await tx.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);

    result = {
      success: true,
      seats: releasedSeats.rows,
      _released: released,
    };
  });

  // Broadcast
  if (result._released) {
    broadcastReleases(result._released);
    delete result._released;
  }

  if (result.success) {
    for (const seat of result.seats) {
      broadcast("seat-update", {
        seatId: seat.id,
        row_label: seat.row_label,
        seat_number: seat.seat_number,
        status: "available",
        holdId: null,
        holdExpiresAt: null,
        sessionId: null,
      });
    }
  }

  return result;
}

/**
 * Periodic sweep to expire stale holds.
 * Called on a timer.
 */
export async function sweepExpiredHolds() {
  try {
    const db = await getDb();
    const released = await expireStaleHolds(db);
    broadcastReleases(released);
    if (released.length > 0) {
      console.log(`Sweep: released ${released.length} expired seat(s)`);
    }
  } catch (err) {
    console.error("Sweep error:", err);
  }
}
