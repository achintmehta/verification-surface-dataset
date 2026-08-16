import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import { addClient, broadcast } from "./sse.js";
import { expireStaleHolds } from "./expiry.js";

const router = Router();

const HOLD_TTL_SECONDS = 60; // 60 second hold TTL

// ---------- SSE Endpoint ----------
router.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("event: connected\ndata: {}\n\n");
  addClient(res);

  // Send heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(":heartbeat\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
  });
});

// ---------- GET /api/seats ----------
router.get("/seats", async (req, res) => {
  try {
    // Expire stale holds first
    await expireStaleHolds();

    const db = await getDb();
    const result = await db.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
       FROM seats
       ORDER BY row_label, seat_number`
    );

    // Compute effective status: held seats past TTL are shown as available
    const seats = result.rows.map((seat) => {
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
          session_id: null,
        };
      }
      return seat;
    });

    res.json({ seats });
  } catch (err) {
    console.error("GET /api/seats error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- POST /api/holds ----------
router.post("/holds", async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: "seatIds must be a non-empty array" });
  }
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required" });
  }

  // Normalize seat IDs to integers
  const normalizedSeatIds = seatIds.map((id) => parseInt(id, 10));
  if (normalizedSeatIds.some(isNaN)) {
    return res.status(400).json({ error: "All seatIds must be valid integers" });
  }

  try {
    const db = await getDb();
    let holdResult = null;
    let updatedSeats = [];
    let conflicting = [];

    await db.transaction(async (tx) => {
      // First, expire stale holds within the transaction
      const expiredHolds = await tx.query(
        `UPDATE holds
         SET status = 'expired'
         WHERE status = 'active' AND expires_at <= NOW()
         RETURNING id, seat_ids`
      );

      // Free expired held seats
      const expiredSeatIds = [];
      for (const h of expiredHolds.rows) {
        if (h.seat_ids) expiredSeatIds.push(...h.seat_ids);
      }
      if (expiredSeatIds.length > 0) {
        await tx.query(
          `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
           WHERE id = ANY($1) AND status = 'held'`,
          [expiredSeatIds]
        );
      }

      // Lock the requested seats in order to prevent races (SELECT FOR UPDATE)
      const lockResult = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, session_id
         FROM seats
         WHERE id = ANY($1)
         ORDER BY id
         FOR UPDATE`,
        [normalizedSeatIds]
      );

      if (lockResult.rows.length !== normalizedSeatIds.length) {
        const foundIds = new Set(lockResult.rows.map((r) => r.id));
        const notFound = normalizedSeatIds.filter((id) => !foundIds.has(id));
        throw { status: 400, error: "Some seat IDs are invalid", invalidIds: notFound };
      }

      // Check if all seats are available
      const unavailable = lockResult.rows.filter((s) => s.status !== "available");
      if (unavailable.length > 0) {
        conflicting = unavailable.map((s) => ({
          id: s.id,
          row_label: s.row_label,
          seat_number: s.seat_number,
          status: s.status,
        }));
        throw {
          status: 409,
          error: "Some seats are unavailable",
          conflicting,
        };
      }

      // All seats are available — create the hold
      const holdId = uuidv4();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

      await tx.query(
        `INSERT INTO holds (id, session_id, seat_ids, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [holdId, sessionId, normalizedSeatIds, expiresAt]
      );

      // Mark seats as held
      const updateResult = await tx.query(
        `UPDATE seats
         SET status = 'held', hold_id = $1, hold_expires_at = $2, session_id = $3
         WHERE id = ANY($4)
         RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by`,
        [holdId, expiresAt, sessionId, normalizedSeatIds]
      );

      updatedSeats = updateResult.rows;
      holdResult = {
        holdId,
        sessionId,
        seatIds: normalizedSeatIds,
        expiresAt,
      };
    });

    // Broadcast seat updates (expired seats that were freed + newly held seats)
    for (const seat of updatedSeats) {
      broadcast("seat-update", seat);
    }

    res.status(201).json({ hold: holdResult, seats: updatedSeats });
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({
        error: err.error,
        conflicting: err.conflicting,
      });
    }
    if (err.status === 400) {
      return res.status(400).json({ error: err.error, invalidIds: err.invalidIds });
    }
    console.error("POST /api/holds error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- POST /api/holds/:holdId/confirm ----------
router.post("/holds/:holdId/confirm", async (req, res) => {
  const { holdId } = req.params;

  try {
    const db = await getDb();
    let confirmedSeats = [];
    let holdInfo = null;

    await db.transaction(async (tx) => {
      // First, expire stale holds
      const expiredHolds = await tx.query(
        `UPDATE holds
         SET status = 'expired'
         WHERE status = 'active' AND expires_at <= NOW()
         RETURNING id, seat_ids`
      );

      const expiredSeatIds = [];
      for (const h of expiredHolds.rows) {
        if (h.seat_ids) expiredSeatIds.push(...h.seat_ids);
      }
      if (expiredSeatIds.length > 0) {
        await tx.query(
          `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
           WHERE id = ANY($1) AND status = 'held'`,
          [expiredSeatIds]
        );
      }

      // Look up the hold with a lock
      const holdLookup = await tx.query(
        `SELECT id, session_id, seat_ids, expires_at, status
         FROM holds
         WHERE id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holdLookup.rows.length === 0) {
        throw { status: 404, error: "Hold not found" };
      }

      const hold = holdLookup.rows[0];

      // Idempotent: if already confirmed, return the booking
      if (hold.status === "confirmed") {
        const seats = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
           FROM seats
           WHERE id = ANY($1)
           ORDER BY id`,
          [hold.seat_ids]
        );
        holdInfo = hold;
        confirmedSeats = seats.rows;
        return; // idempotent success
      }

      // Check if hold is expired or released
      if (hold.status === "expired" || hold.status === "released") {
        throw { status: 410, error: `Hold has been ${hold.status}` };
      }

      if (new Date(hold.expires_at) <= new Date()) {
        // Mark hold as expired
        await tx.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [holdId]);
        // Release seats
        await tx.query(
          `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
           WHERE id = ANY($1) AND status = 'held' AND hold_id = $2`,
          [hold.seat_ids, holdId]
        );
        throw { status: 410, error: "Hold has expired" };
      }

      // Verify the seats are still held by this hold
      const seatCheck = await tx.query(
        `SELECT id, status, hold_id
         FROM seats
         WHERE id = ANY($1)
         FOR UPDATE`,
        [hold.seat_ids]
      );

      const invalidSeats = seatCheck.rows.filter(
        (s) => s.status !== "held" || s.hold_id !== holdId
      );
      if (invalidSeats.length > 0) {
        throw {
          status: 409,
          error: "Some seats are no longer held by this hold",
        };
      }

      // Confirm: mark seats as booked
      const bookResult = await tx.query(
        `UPDATE seats
         SET status = 'booked', booked_by = $1, hold_expires_at = NULL
         WHERE id = ANY($2) AND hold_id = $3
         RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by`,
        [hold.session_id, hold.seat_ids, holdId]
      );

      // Mark hold as confirmed
      await tx.query(`UPDATE holds SET status = 'confirmed' WHERE id = $1`, [holdId]);

      holdInfo = { ...hold, status: "confirmed" };
      confirmedSeats = bookResult.rows;
    });

    // Broadcast seat updates
    for (const seat of confirmedSeats) {
      if (seat.status === "booked") {
        broadcast("seat-update", seat);
      }
    }

    res.json({
      hold: holdInfo,
      seats: confirmedSeats,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error });
    }
    console.error("POST /api/holds/:holdId/confirm error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- DELETE /api/holds/:holdId ----------
router.delete("/holds/:holdId", async (req, res) => {
  const { holdId } = req.params;

  try {
    const db = await getDb();
    let releasedSeats = [];

    await db.transaction(async (tx) => {
      // Lock the hold
      const holdLookup = await tx.query(
        `SELECT id, session_id, seat_ids, expires_at, status
         FROM holds
         WHERE id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holdLookup.rows.length === 0) {
        throw { status: 404, error: "Hold not found" };
      }

      const hold = holdLookup.rows[0];

      if (hold.status === "confirmed") {
        throw { status: 400, error: "Cannot release a confirmed hold" };
      }

      if (hold.status === "released") {
        // Idempotent — already released
        return;
      }

      // Mark hold as released
      await tx.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);

      // Release the seats
      const releaseResult = await tx.query(
        `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
         WHERE id = ANY($1) AND hold_id = $2 AND status = 'held'
         RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by`,
        [hold.seat_ids, holdId]
      );

      releasedSeats = releaseResult.rows;
    });

    // Broadcast releases
    for (const seat of releasedSeats) {
      broadcast("seat-update", seat);
    }

    res.json({ released: true, seats: releasedSeats });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error });
    }
    console.error("DELETE /api/holds/:holdId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- GET /api/inventory ----------
router.get("/inventory", async (req, res) => {
  try {
    await expireStaleHolds();
    const db = await getDb();
    const result = await db.query(
      `SELECT status, COUNT(*) as count FROM seats GROUP BY status`
    );
    const inventory = { available: 0, held: 0, booked: 0 };
    for (const row of result.rows) {
      inventory[row.status] = parseInt(row.count, 10);
    }
    inventory.total = inventory.available + inventory.held + inventory.booked;
    res.json(inventory);
  } catch (err) {
    console.error("GET /api/inventory error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
