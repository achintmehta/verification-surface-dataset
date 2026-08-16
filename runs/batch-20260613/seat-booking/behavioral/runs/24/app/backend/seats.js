import { getDb } from "./db.js";
import { broadcast } from "./sse.js";
import { v4 as uuidv4 } from "uuid";

// Hold TTL in seconds
const HOLD_TTL_SECONDS = 60;

// ---- Expiry helpers ----

/**
 * Release any holds that have expired. Returns the ids of released seats.
 * Can be called with a tx (PGLite transaction) or standalone.
 */
export async function releaseExpiredHolds(pg) {
  if (!pg) pg = await getDb();
  const { rows: released } = await pg.query(`
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
  return released;
}

/**
 * Sweep expired holds and broadcast releases.
 */
export async function sweepExpiredHolds() {
  const pg = await getDb();
  const released = await releaseExpiredHolds(pg);
  if (released.length > 0) {
    broadcast("seats-updated", released.map(s => ({
      id: s.id,
      row_label: s.row_label,
      seat_number: s.seat_number,
      status: "available",
      hold_id: null,
      hold_expires_at: null,
      session_id: null,
      booked_by: null,
    })));
  }
  return released;
}

// ---- Read ----

export async function getAllSeats() {
  const pg = await getDb();
  // First sweep expired holds
  await sweepExpiredHolds();
  const { rows } = await pg.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by, session_id
      FROM seats
     ORDER BY row_label, seat_number
  `);
  return rows;
}

// ---- Hold ----

export async function createHold(seatIds, sessionId) {
  const pg = await getDb();
  const holdId = uuidv4();
  const ttl = HOLD_TTL_SECONDS;

  // Use PGLite's transaction method which serializes access
  const result = await pg.transaction(async (tx) => {
    // Step 0: release expired holds inside the transaction
    await releaseExpiredHolds(tx);

    // Step 1: Lock and check all requested seats
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
    const { rows: seats } = await tx.query(
      `SELECT id, row_label, seat_number, status, hold_id
         FROM seats
        WHERE id IN (${placeholders})
        FOR UPDATE`,
      seatIds
    );

    // Verify we got all requested seats
    if (seats.length !== seatIds.length) {
      const foundIds = new Set(seats.map(s => s.id));
      const missing = seatIds.filter(id => !foundIds.has(id));
      return { error: "not_found", message: "Some seat ids do not exist", missingIds: missing };
    }

    // Step 2: Check that all are available
    const conflicts = seats.filter(s => s.status !== "available");
    if (conflicts.length > 0) {
      return {
        error: "conflict",
        message: "Some seats are not available",
        conflictingSeatIds: conflicts.map(s => s.id),
      };
    }

    // Step 3: Atomically mark them held
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 4}`).join(", ");
    await tx.query(
      `UPDATE seats
          SET status = 'held',
              hold_id = $1,
              hold_expires_at = $2::timestamptz,
              session_id = $3
        WHERE id IN (${updatePlaceholders})`,
      [holdId, expiresAt, sessionId, ...seatIds]
    );

    // Fetch updated seats for return
    const { rows: updated } = await tx.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
         FROM seats WHERE hold_id = $1`,
      [holdId]
    );

    return {
      ok: true,
      holdId,
      expiresAt,
      seats: updated,
    };
  });

  // Broadcast outside the transaction
  if (result.ok) {
    broadcast("seats-updated", result.seats);
  }

  // If expired holds were released during the tx, we should also broadcast those
  // but we handle that via sweepExpiredHolds above.

  return result;
}

// ---- Confirm ----

export async function confirmHold(holdId) {
  const pg = await getDb();

  const result = await pg.transaction(async (tx) => {
    // Sweep expired holds first
    const released = await releaseExpiredHolds(tx);

    // Lock the seats that belong to this hold (still held)
    const { rows: seats } = await tx.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
         FROM seats
        WHERE hold_id = $1
        FOR UPDATE`,
      [holdId]
    );

    if (seats.length === 0) {
      return { error: "not_found", message: "Hold not found or expired", _released: released };
    }

    const allHeld = seats.every(s => s.status === "held");
    const allBooked = seats.every(s => s.status === "booked");

    if (allBooked) {
      // Idempotent return
      return { ok: true, alreadyConfirmed: true, seats, _released: released };
    }

    if (!allHeld) {
      // Mixed state - some booked some held shouldn't happen with our logic
      // but handle gracefully
      return { error: "invalid_state", message: "Hold seats are in an inconsistent state", _released: released };
    }

    // Check expiry inside the transaction
    const anyExpired = seats.some(s => s.hold_expires_at && new Date(s.hold_expires_at) <= new Date());
    if (anyExpired) {
      // Mark them as available (they expired)
      const ids = seats.map(s => s.id);
      const ph = ids.map((_, i) => `$${i + 1}`).join(", ");
      await tx.query(
        `UPDATE seats
            SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
          WHERE id IN (${ph})`,
        ids
      );
      const releasedSeats = seats.map(s => ({
        id: s.id, row_label: s.row_label, seat_number: s.seat_number,
        status: "available", hold_id: null, hold_expires_at: null, session_id: null, booked_by: null,
      }));
      return { error: "expired", message: "Hold has expired", _released: [...released, ...releasedSeats] };
    }

    // Mark them booked
    const sessionId = seats[0].session_id;
    const ids = seats.map(s => s.id);
    const ph = ids.map((_, i) => `$${i + 2}`).join(", ");
    await tx.query(
      `UPDATE seats
          SET status = 'booked',
              booked_by = $1,
              hold_expires_at = NULL
        WHERE id IN (${ph})`,
      [sessionId, ...ids]
    );

    const { rows: updated } = await tx.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
         FROM seats WHERE hold_id = $1`,
      [holdId]
    );

    return { ok: true, seats: updated, _released: released };
  });

  // Broadcast released holds
  if (result._released && result._released.length > 0) {
    const releasedForBroadcast = result._released.map(s => ({
      id: s.id, row_label: s.row_label, seat_number: s.seat_number,
      status: "available", hold_id: null, hold_expires_at: null, session_id: null, booked_by: null,
    }));
    broadcast("seats-updated", releasedForBroadcast);
  }

  // Broadcast booked seats
  if (result.ok && !result.alreadyConfirmed) {
    broadcast("seats-updated", result.seats);
  }

  // Clean up internal field
  const { _released, ...cleanResult } = result;
  return cleanResult;
}

// ---- Release ----

export async function releaseHold(holdId) {
  const pg = await getDb();

  const result = await pg.transaction(async (tx) => {
    const { rows: seats } = await tx.query(
      `SELECT id, row_label, seat_number, status, hold_id
         FROM seats
        WHERE hold_id = $1 AND status = 'held'
        FOR UPDATE`,
      [holdId]
    );

    if (seats.length === 0) {
      return { error: "not_found", message: "Hold not found or already released/confirmed" };
    }

    const ids = seats.map(s => s.id);
    const ph = ids.map((_, i) => `$${i + 1}`).join(", ");
    await tx.query(
      `UPDATE seats
          SET status = 'available',
              hold_id = NULL,
              hold_expires_at = NULL,
              session_id = NULL
        WHERE id IN (${ph})`,
      ids
    );

    const released = seats.map(s => ({
      id: s.id, row_label: s.row_label, seat_number: s.seat_number,
      status: "available", hold_id: null, hold_expires_at: null, session_id: null, booked_by: null,
    }));

    return { ok: true, released };
  });

  if (result.ok) {
    broadcast("seats-updated", result.released);
  }

  return result;
}

// ---- Inventory ----

export async function getInventory() {
  const pg = await getDb();
  await sweepExpiredHolds();
  const { rows } = await pg.query(`
    SELECT
      count(*) FILTER (WHERE status = 'available')::int AS available,
      count(*) FILTER (WHERE status = 'held')::int AS held,
      count(*) FILTER (WHERE status = 'booked')::int AS booked,
      count(*)::int AS total
    FROM seats
  `);
  return rows[0];
}
