import { randomUUID } from "crypto";
import { broadcast } from "./sse.js";

// Hold TTL in seconds
const HOLD_TTL_SECONDS = 30;
// Sweep interval in milliseconds
const SWEEP_INTERVAL_MS = 5000;

let db;

export function initSeatsModule(database) {
  db = database;
  // Start periodic sweep for expired holds
  setInterval(sweepExpiredHolds, SWEEP_INTERVAL_MS);
}

/**
 * Release any expired holds in the database and broadcast changes.
 * This is called lazily on reads and periodically via sweep.
 */
export async function releaseExpiredHolds() {
  // First, update the holds table to mark expired holds
  await db.query(`
    UPDATE holds
    SET status = 'expired'
    WHERE status = 'active' AND expires_at <= NOW()
  `);

  // Then find and release expired seats
  const expired = await db.query(`
    UPDATE seats
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
    WHERE status = 'held' AND hold_expires_at <= NOW()
    RETURNING id, row_label, seat_number
  `);

  if (expired.rows.length > 0) {
    // Broadcast each released seat
    const seatUpdates = expired.rows.map((s) => ({
      id: s.id,
      row_label: s.row_label,
      seat_number: s.seat_number,
      status: "available",
      hold_id: null,
      hold_expires_at: null,
      session_id: null,
      booked_by: null,
    }));
    broadcast("seats-updated", seatUpdates);
  }

  return expired.rows;
}

async function sweepExpiredHolds() {
  try {
    await releaseExpiredHolds();
  } catch (e) {
    console.error("Sweep error:", e);
  }
}

/**
 * Get all seats with effective status (expired holds shown as available).
 */
export async function getAllSeats() {
  // First release expired holds
  await releaseExpiredHolds();

  const result = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
    FROM seats
    ORDER BY row_label, seat_number
  `);

  return result.rows.map((seat) => ({
    ...seat,
    // Double-check: if somehow still marked held but expired, treat as available
    status:
      seat.status === "held" &&
      seat.hold_expires_at &&
      new Date(seat.hold_expires_at) <= new Date()
        ? "available"
        : seat.status,
  }));
}

/**
 * Atomically hold all requested seats for a session.
 * All-or-nothing: if any seat is unavailable, none are held.
 *
 * Uses a transaction for atomicity. PGlite is single-connection,
 * and Node.js is single-threaded, so within a transaction block
 * no other query can interleave.
 */
export async function createHold(seatIds, sessionId) {
  if (!seatIds || seatIds.length === 0) {
    throw { status: 400, message: "seatIds must be a non-empty array" };
  }
  if (!sessionId) {
    throw { status: 400, message: "sessionId is required" };
  }

  // Release expired holds first
  await releaseExpiredHolds();

  const holdId = randomUUID();
  const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

  // Build the transaction
  const result = await db.transaction(async (tx) => {
    // Fetch the requested seats (locked within transaction)
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
    const locked = await tx.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
       FROM seats
       WHERE id IN (${placeholders})`,
      seatIds
    );

    if (locked.rows.length !== seatIds.length) {
      const foundIds = new Set(locked.rows.map((r) => r.id));
      const missingIds = seatIds.filter((id) => !foundIds.has(id));
      return {
        error: true,
        status: 400,
        message: "Some seat IDs do not exist",
        missingIds,
      };
    }

    // Check availability - treat expired holds as available
    const now = new Date();
    const unavailable = [];
    const expiredInTx = [];

    for (const seat of locked.rows) {
      if (seat.status === "booked") {
        unavailable.push({
          id: seat.id,
          row_label: seat.row_label,
          seat_number: seat.seat_number,
          status: "booked",
        });
      } else if (seat.status === "held") {
        if (seat.hold_expires_at && new Date(seat.hold_expires_at) <= now) {
          // Expired hold - we can reclaim it in this transaction
          expiredInTx.push(seat.id);
        } else {
          unavailable.push({
            id: seat.id,
            row_label: seat.row_label,
            seat_number: seat.seat_number,
            status: "held",
          });
        }
      }
      // 'available' is fine
    }

    if (unavailable.length > 0) {
      return {
        error: true,
        status: 409,
        message: "Some seats are unavailable",
        conflictingSeats: unavailable,
      };
    }

    // Release any expired holds found during the check
    if (expiredInTx.length > 0) {
      const expPlaceholders = expiredInTx.map((_, i) => `$${i + 1}`).join(", ");
      await tx.query(
        `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
         WHERE id IN (${expPlaceholders})`,
        expiredInTx
      );
      // Also mark those holds as expired in the holds table
      await tx.query(
        `UPDATE holds SET status = 'expired'
         WHERE status = 'active' AND expires_at <= NOW()`
      );
    }

    // Now hold all the seats atomically
    const updateParams = [holdId, expiresAt.toISOString(), sessionId, ...seatIds];
    const seatPlaceholders = seatIds.map((_, i) => `$${i + 4}`).join(", ");

    const updated = await tx.query(
      `UPDATE seats
       SET status = 'held', hold_id = $1, hold_expires_at = $2, session_id = $3
       WHERE id IN (${seatPlaceholders})
       RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, session_id`,
      updateParams
    );

    // Insert hold record
    // Format seatIds as a PostgreSQL array literal for safe insertion
    const pgArray = `{${seatIds.join(",")}}`;
    await tx.query(
      `INSERT INTO holds (id, session_id, seat_ids, expires_at)
       VALUES ($1, $2, $3::integer[], $4)`,
      [holdId, sessionId, pgArray, expiresAt.toISOString()]
    );

    return {
      error: false,
      hold: { id: holdId, sessionId, seatIds, expiresAt },
      seats: updated.rows,
    };
  });

  if (result.error) {
    throw result;
  }

  // Broadcast the seat updates
  const seatUpdates = result.seats.map((s) => ({
    id: s.id,
    row_label: s.row_label,
    seat_number: s.seat_number,
    status: s.status,
    hold_id: s.hold_id,
    hold_expires_at: s.hold_expires_at,
    session_id: s.session_id,
    booked_by: null,
  }));
  broadcast("seats-updated", seatUpdates);

  return result.hold;
}

/**
 * Confirm a hold - idempotent. Books the seats permanently.
 */
export async function confirmHold(holdId) {
  // Release expired holds first
  await releaseExpiredHolds();

  const result = await db.transaction(async (tx) => {
    // Fetch the hold record
    const holdResult = await tx.query(
      `SELECT id, session_id, seat_ids, expires_at, status, confirmed_at
       FROM holds
       WHERE id = $1`,
      [holdId]
    );

    if (holdResult.rows.length === 0) {
      return { error: true, status: 404, message: "Hold not found" };
    }

    const hold = holdResult.rows[0];

    // Idempotent: if already confirmed, return success
    if (hold.status === "confirmed") {
      const seatIds = hold.seat_ids;
      const seatPlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
      const seats = await tx.query(
        `SELECT id, row_label, seat_number, status, booked_by
         FROM seats WHERE id IN (${seatPlaceholders})`,
        seatIds
      );
      return {
        error: false,
        idempotent: true,
        hold: {
          id: hold.id,
          sessionId: hold.session_id,
          seatIds: hold.seat_ids,
          confirmedAt: hold.confirmed_at,
        },
        seats: seats.rows,
      };
    }

    // Check if expired
    if (hold.status === "expired" || new Date(hold.expires_at) <= new Date()) {
      // Mark it expired if not already
      if (hold.status !== "expired") {
        await tx.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [holdId]);
        // Release the seats that still belong to this hold
        const seatIds = hold.seat_ids;
        const seatPlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
        await tx.query(
          `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
           WHERE id IN (${seatPlaceholders}) AND hold_id = $${seatIds.length + 1}`,
          [...seatIds, holdId]
        );
      }
      return { error: true, status: 410, message: "Hold has expired" };
    }

    // Check if released
    if (hold.status === "released") {
      return { error: true, status: 410, message: "Hold was released" };
    }

    // Verify the seats are still held by this hold
    const seatIds = hold.seat_ids;
    const seatPlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
    const seatCheck = await tx.query(
      `SELECT id, status, hold_id
       FROM seats
       WHERE id IN (${seatPlaceholders})`,
      seatIds
    );

    // Make sure all seats are still held by this hold
    for (const seat of seatCheck.rows) {
      if (seat.status !== "held" || seat.hold_id !== holdId) {
        return {
          error: true,
          status: 409,
          message: "Hold is no longer valid - seats have changed state",
        };
      }
    }

    // Book the seats
    const updateParams = [hold.session_id, holdId, ...seatIds];
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 3}`).join(", ");

    const booked = await tx.query(
      `UPDATE seats
       SET status = 'booked', booked_by = $1, hold_id = NULL, hold_expires_at = NULL
       WHERE id IN (${updatePlaceholders}) AND hold_id = $2
       RETURNING id, row_label, seat_number, status, booked_by, session_id`,
      updateParams
    );

    // Update hold record
    await tx.query(
      `UPDATE holds SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1`,
      [holdId]
    );

    return {
      error: false,
      idempotent: false,
      hold: {
        id: hold.id,
        sessionId: hold.session_id,
        seatIds: hold.seat_ids,
        confirmedAt: new Date(),
      },
      seats: booked.rows,
    };
  });

  if (result.error) {
    throw result;
  }

  // Broadcast seat updates
  const seatUpdates = result.seats.map((s) => ({
    id: s.id,
    row_label: s.row_label,
    seat_number: s.seat_number,
    status: "booked",
    hold_id: null,
    hold_expires_at: null,
    session_id: s.session_id,
    booked_by: s.booked_by,
  }));
  broadcast("seats-updated", seatUpdates);

  return result;
}

/**
 * Release a hold early, returning its seats to available.
 */
export async function releaseHold(holdId) {
  const result = await db.transaction(async (tx) => {
    const holdResult = await tx.query(
      `SELECT id, session_id, seat_ids, expires_at, status
       FROM holds
       WHERE id = $1`,
      [holdId]
    );

    if (holdResult.rows.length === 0) {
      return { error: true, status: 404, message: "Hold not found" };
    }

    const hold = holdResult.rows[0];

    // Can only release an active or expired hold (not confirmed)
    if (hold.status === "confirmed") {
      return {
        error: true,
        status: 409,
        message: "Hold is already confirmed and cannot be released",
      };
    }

    if (hold.status === "released") {
      // Idempotent release
      return { error: false, message: "Hold was already released", seats: [] };
    }

    // Release the seats that belong to this hold
    const seatIds = hold.seat_ids;
    const seatPlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");

    const released = await tx.query(
      `UPDATE seats
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
       WHERE id IN (${seatPlaceholders}) AND hold_id = $${seatIds.length + 1}
       RETURNING id, row_label, seat_number`,
      [...seatIds, holdId]
    );

    await tx.query(
      `UPDATE holds SET status = 'released' WHERE id = $1`,
      [holdId]
    );

    return { error: false, message: "Hold released", seats: released.rows };
  });

  if (result.error) {
    throw result;
  }

  // Broadcast the releases
  if (result.seats.length > 0) {
    const seatUpdates = result.seats.map((s) => ({
      id: s.id,
      row_label: s.row_label,
      seat_number: s.seat_number,
      status: "available",
      hold_id: null,
      hold_expires_at: null,
      session_id: null,
      booked_by: null,
    }));
    broadcast("seats-updated", seatUpdates);
  }

  return result;
}

/**
 * Get inventory counts
 */
export async function getInventory() {
  await releaseExpiredHolds();

  const result = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'available') as available,
      COUNT(*) FILTER (WHERE status = 'held') as held,
      COUNT(*) FILTER (WHERE status = 'booked') as booked,
      COUNT(*) as total
    FROM seats
  `);

  return result.rows[0];
}
