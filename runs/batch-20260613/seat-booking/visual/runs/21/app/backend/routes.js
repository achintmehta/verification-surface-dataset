import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import { addClient, broadcast } from "./sse.js";
import { expireStaleHolds } from "./expiry.js";

const router = Router();

const HOLD_TTL_SECONDS = 30;

// ==================== SSE ====================
router.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("event: connected\ndata: {}\n\n");
  addClient(res);

  // Send heartbeat every 15s to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
  });
});

// ==================== GET SEATS ====================
router.get("/seats", async (req, res) => {
  try {
    // Expire stale holds first
    await expireStaleHolds();

    const db = await getDb();
    const result = await db.query(`
      SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
      FROM seats
      ORDER BY row_label, seat_number
    `);

    // Compute effective status: if held but expired, show as available
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
    console.error("GET /seats error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ==================== POST HOLD ====================
router.post("/holds", async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: "seatIds must be a non-empty array" });
  }
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required" });
  }

  // Deduplicate
  const uniqueSeatIds = [...new Set(seatIds.map(Number))];

  try {
    const db = await getDb();

    // Expire stale holds first
    await expireStaleHolds();

    const holdId = uuidv4();
    const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

    let heldSeats = [];
    let conflictIds = [];

    await db.transaction(async (tx) => {
      // Lock and check all requested seats atomically
      // Use FOR UPDATE to prevent concurrent modifications
      const placeholders = uniqueSeatIds.map((_, i) => `$${i + 1}`).join(", ");
      const lockResult = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
         FROM seats
         WHERE id IN (${placeholders})
         FOR UPDATE`,
        uniqueSeatIds
      );

      if (lockResult.rows.length !== uniqueSeatIds.length) {
        const foundIds = new Set(lockResult.rows.map((r) => r.id));
        const missing = uniqueSeatIds.filter((id) => !foundIds.has(id));
        throw { statusCode: 400, error: "Invalid seat IDs", invalidIds: missing };
      }

      // Check each seat - treat expired holds as available
      const now = new Date();
      conflictIds = [];
      const expiredHoldIds = new Set();

      for (const seat of lockResult.rows) {
        if (seat.status === "held" && seat.hold_expires_at && new Date(seat.hold_expires_at) <= now) {
          // This hold is expired, treat as available
          if (seat.hold_id) expiredHoldIds.add(seat.hold_id);
          continue; // available
        }
        if (seat.status !== "available") {
          conflictIds.push(seat.id);
        }
      }

      if (conflictIds.length > 0) {
        throw { statusCode: 409, error: "Seats unavailable", conflictingSeatIds: conflictIds };
      }

      // Release any expired holds we found (within this transaction)
      if (expiredHoldIds.size > 0) {
        const expHoldArr = [...expiredHoldIds];
        const expPlaceholders = expHoldArr.map((_, i) => `$${i + 1}`).join(", ");
        await tx.query(
          `UPDATE holds SET status = 'expired' WHERE id IN (${expPlaceholders}) AND status = 'active'`,
          expHoldArr
        );
      }

      // All seats are available; mark them held
      const updatePlaceholders = uniqueSeatIds.map((_, i) => `$${i + 4}`).join(", ");
      await tx.query(
        `UPDATE seats 
         SET status = 'held', hold_id = $1, hold_expires_at = $2, session_id = $3
         WHERE id IN (${updatePlaceholders})`,
        [holdId, expiresAt.toISOString(), sessionId, ...uniqueSeatIds]
      );

      // Create the hold record
      await tx.query(
        `INSERT INTO holds (id, session_id, seat_ids, expires_at) VALUES ($1, $2, $3, $4)`,
        [holdId, sessionId, uniqueSeatIds, expiresAt.toISOString()]
      );

      // Get updated seats for response & broadcast
      const updatedResult = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
         FROM seats WHERE id IN (${placeholders})`,
        uniqueSeatIds
      );
      heldSeats = updatedResult.rows;
    });

    // Broadcast updates
    broadcast("seatUpdate", heldSeats);

    res.status(201).json({
      holdId,
      sessionId,
      seatIds: uniqueSeatIds,
      expiresAt: expiresAt.toISOString(),
      ttlSeconds: HOLD_TTL_SECONDS,
      seats: heldSeats,
    });
  } catch (err) {
    if (err.statusCode === 409) {
      return res.status(409).json({
        error: err.error,
        conflictingSeatIds: err.conflictingSeatIds,
      });
    }
    if (err.statusCode === 400) {
      return res.status(400).json({ error: err.error, invalidIds: err.invalidIds });
    }
    console.error("POST /holds error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ==================== CONFIRM HOLD ====================
router.post("/holds/:holdId/confirm", async (req, res) => {
  const { holdId } = req.params;

  try {
    const db = await getDb();

    let bookedSeats = [];
    let alreadyConfirmed = false;

    await db.transaction(async (tx) => {
      // Look up the hold
      const holdResult = await tx.query(
        `SELECT id, session_id, seat_ids, expires_at, status FROM holds WHERE id = $1 FOR UPDATE`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        throw { statusCode: 404, error: "Hold not found" };
      }

      const hold = holdResult.rows[0];

      // Idempotent: if already confirmed, return success with the booked seats
      if (hold.status === "confirmed") {
        const seatsResult = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
           FROM seats WHERE booked_by = $1 AND hold_id = $2`,
          [hold.session_id, holdId]
        );
        bookedSeats = seatsResult.rows;
        alreadyConfirmed = true;
        return;
      }

      // Check if expired
      if (hold.status === "expired" || new Date(hold.expires_at) <= new Date()) {
        // Mark as expired if not already
        await tx.query(
          `UPDATE holds SET status = 'expired' WHERE id = $1 AND status = 'active'`,
          [holdId]
        );
        // Release seats that were still marked for this hold
        await tx.query(
          `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
           WHERE hold_id = $1 AND status = 'held'`,
          [holdId]
        );
        throw { statusCode: 410, error: "Hold has expired" };
      }

      if (hold.status === "released") {
        throw { statusCode: 410, error: "Hold was released" };
      }

      if (hold.status !== "active") {
        throw { statusCode: 400, error: `Hold is in unexpected status: ${hold.status}` };
      }

      // Verify that all seats are still held by this hold
      const seatIds = hold.seat_ids;
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
      const seatsResult = await tx.query(
        `SELECT id, status, hold_id FROM seats WHERE id IN (${placeholders}) FOR UPDATE`,
        seatIds
      );

      // Check each seat is held by this hold
      for (const seat of seatsResult.rows) {
        if (seat.hold_id !== holdId || seat.status !== "held") {
          throw {
            statusCode: 409,
            error: "Some seats are no longer held by this hold",
          };
        }
      }

      // Book the seats
      await tx.query(
        `UPDATE seats 
         SET status = 'booked', booked_by = $1, hold_expires_at = NULL
         WHERE hold_id = $2 AND status = 'held'`,
        [hold.session_id, holdId]
      );

      // Mark hold as confirmed
      await tx.query(
        `UPDATE holds SET status = 'confirmed' WHERE id = $1`,
        [holdId]
      );

      // Get updated seats
      const updatedSeats = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
         FROM seats WHERE hold_id = $1`,
        [holdId]
      );
      bookedSeats = updatedSeats.rows;
    });

    // Broadcast
    if (!alreadyConfirmed && bookedSeats.length > 0) {
      broadcast("seatUpdate", bookedSeats);
    }

    res.json({
      holdId,
      status: "confirmed",
      seats: bookedSeats,
    });
  } catch (err) {
    if (err.statusCode) {
      // Also broadcast seat releases if hold expired during confirm
      if (err.statusCode === 410) {
        try {
          const db = await getDb();
          // Fetch any seats that were just released
          const released = await db.query(
            `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
             FROM seats WHERE status = 'available' AND hold_id IS NULL`
          );
          // We can't easily know which were just released, so rely on the sweep
        } catch (_) {}
      }
      return res.status(err.statusCode).json({ error: err.error });
    }
    console.error("POST /holds/:holdId/confirm error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ==================== DELETE (RELEASE) HOLD ====================
router.delete("/holds/:holdId", async (req, res) => {
  const { holdId } = req.params;

  try {
    const db = await getDb();
    let releasedSeats = [];

    await db.transaction(async (tx) => {
      const holdResult = await tx.query(
        `SELECT id, session_id, seat_ids, status FROM holds WHERE id = $1 FOR UPDATE`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        throw { statusCode: 404, error: "Hold not found" };
      }

      const hold = holdResult.rows[0];

      if (hold.status === "confirmed") {
        throw { statusCode: 400, error: "Cannot release a confirmed hold" };
      }

      if (hold.status === "released" || hold.status === "expired") {
        // Already released, return idempotent
        return;
      }

      // Release seats by hold_id
      await tx.query(
        `UPDATE seats 
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
         WHERE hold_id = $1 AND status = 'held'`,
        [holdId]
      );

      // Mark hold as released
      await tx.query(
        `UPDATE holds SET status = 'released' WHERE id = $1`,
        [holdId]
      );

      // Get updated seats
      const seatIds = hold.seat_ids;
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
      const updatedSeats = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
         FROM seats WHERE id IN (${placeholders})`,
        seatIds
      );
      releasedSeats = updatedSeats.rows;
    });

    // Broadcast
    if (releasedSeats.length > 0) {
      broadcast("seatUpdate", releasedSeats);
    }

    res.json({ holdId, status: "released", seats: releasedSeats });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.error });
    }
    console.error("DELETE /holds/:holdId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ==================== INVENTORY CHECK ====================
router.get("/inventory", async (req, res) => {
  try {
    await expireStaleHolds();
    const db = await getDb();
    const result = await db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'available') as available,
        COUNT(*) FILTER (WHERE status = 'held' AND hold_expires_at > NOW()) as held,
        COUNT(*) FILTER (WHERE status = 'booked') as booked,
        COUNT(*) as total
      FROM seats
    `);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET /inventory error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
