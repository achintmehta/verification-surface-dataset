import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import { addClient, broadcast } from "./sse.js";
import { expireStaleHolds } from "./expiry.js";

const router = Router();

const HOLD_TTL_SECONDS = 30; // 30-second hold TTL

// ============================================================================
// GET /api/seats — return all seats with effective status
// ============================================================================
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

    res.json({ seats: result.rows });
  } catch (err) {
    console.error("GET /api/seats error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// POST /api/holds — atomically hold requested seats
// ============================================================================
router.post("/holds", async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: "seatIds must be a non-empty array" });
  }
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required" });
  }

  // Deduplicate and validate
  const uniqueSeatIds = [...new Set(seatIds.map((id) => parseInt(id, 10)))];
  if (uniqueSeatIds.some(isNaN)) {
    return res.status(400).json({ error: "Invalid seat ids" });
  }

  try {
    const db = await getDb();

    const result = await db.transaction(async (tx) => {
      // Step 1: Expire stale holds within this transaction
      const expiredSeats = await tx.query(`
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
      await tx.query(`
        UPDATE holds
        SET status = 'expired'
        WHERE status = 'active'
          AND expires_at <= NOW()
      `);

      // Step 2: Check all requested seats are available
      // Use FOR UPDATE to lock the rows and prevent concurrent modifications
      const placeholders = uniqueSeatIds.map((_, i) => `$${i + 1}`).join(", ");
      const seatCheck = await tx.query(
        `SELECT id, row_label, seat_number, status
         FROM seats
         WHERE id IN (${placeholders})
         FOR UPDATE`,
        uniqueSeatIds
      );

      if (seatCheck.rows.length !== uniqueSeatIds.length) {
        const foundIds = new Set(seatCheck.rows.map((r) => r.id));
        const notFound = uniqueSeatIds.filter((id) => !foundIds.has(id));
        return { error: "not_found", notFoundIds: notFound, expiredSeats: expiredSeats.rows };
      }

      const unavailable = seatCheck.rows.filter((s) => s.status !== "available");
      if (unavailable.length > 0) {
        return {
          error: "conflict",
          conflictingSeatIds: unavailable.map((s) => s.id),
          conflictingSeats: unavailable.map((s) => ({
            id: s.id,
            row_label: s.row_label,
            seat_number: s.seat_number,
            status: s.status,
          })),
          expiredSeats: expiredSeats.rows,
        };
      }

      // Step 3: All seats are available — create the hold
      const holdId = uuidv4();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

      // Update seats
      for (const seatId of uniqueSeatIds) {
        await tx.query(
          `UPDATE seats
           SET status = 'held',
               hold_id = $1,
               hold_expires_at = $2,
               session_id = $3
           WHERE id = $4`,
          [holdId, expiresAt, sessionId, seatId]
        );
      }

      // Insert hold record
      await tx.query(
        `INSERT INTO holds (id, session_id, seat_ids, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [holdId, sessionId, uniqueSeatIds, expiresAt]
      );

      // Fetch updated seats
      const updated = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
         FROM seats
         WHERE id IN (${placeholders})`,
        uniqueSeatIds
      );

      return {
        success: true,
        holdId,
        expiresAt,
        seats: updated.rows,
        expiredSeats: expiredSeats.rows,
      };
    });

    // Broadcast any expired seats that were released during this transaction
    if (result.expiredSeats && result.expiredSeats.length > 0) {
      broadcast("seats-updated", result.expiredSeats.map((s) => ({
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

    if (result.error === "conflict") {
      return res.status(409).json({
        error: "Some seats are unavailable",
        conflictingSeatIds: result.conflictingSeatIds,
        conflictingSeats: result.conflictingSeats,
      });
    }

    if (result.error === "not_found") {
      return res.status(404).json({
        error: "Some seat ids not found",
        notFoundIds: result.notFoundIds,
      });
    }

    // Broadcast held seats
    broadcast("seats-updated", result.seats);

    return res.status(201).json({
      holdId: result.holdId,
      expiresAt: result.expiresAt,
      seats: result.seats,
    });
  } catch (err) {
    console.error("POST /api/holds error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// POST /api/holds/:holdId/confirm — confirm (book) a hold
// ============================================================================
router.post("/holds/:holdId/confirm", async (req, res) => {
  const { holdId } = req.params;

  try {
    const db = await getDb();

    const result = await db.transaction(async (tx) => {
      // Step 1: Expire stale holds within this transaction
      const expiredSeats = await tx.query(`
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
      await tx.query(`
        UPDATE holds
        SET status = 'expired'
        WHERE status = 'active'
          AND expires_at <= NOW()
      `);

      // Step 2: Find the hold
      const holdResult = await tx.query(
        `SELECT id, session_id, seat_ids, expires_at, status
         FROM holds
         WHERE id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        return { error: "not_found", expiredSeats: expiredSeats.rows };
      }

      const hold = holdResult.rows[0];

      // Idempotent: if already confirmed, return the booked seats
      if (hold.status === "confirmed") {
        const seatIds = hold.seat_ids;
        const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
        const seats = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
           FROM seats
           WHERE id IN (${placeholders})`,
          seatIds
        );
        return { success: true, alreadyConfirmed: true, seats: seats.rows, hold, expiredSeats: expiredSeats.rows };
      }

      // If expired or released, reject
      if (hold.status === "expired" || hold.status === "released") {
        return { error: "expired", message: `Hold is ${hold.status}`, expiredSeats: expiredSeats.rows };
      }

      // Double-check expiry by time (belt and suspenders)
      if (new Date(hold.expires_at) <= new Date()) {
        // Mark the hold as expired
        await tx.query(
          `UPDATE holds SET status = 'expired' WHERE id = $1`,
          [holdId]
        );
        // Release seats
        const additionalReleased = await tx.query(
          `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
           WHERE hold_id = $1 AND status = 'held'
           RETURNING id, row_label, seat_number`,
          [holdId]
        );
        return { error: "expired", message: "Hold has expired", expiredSeats: [...expiredSeats.rows, ...additionalReleased.rows] };
      }

      // Step 3: Verify all held seats still belong to this hold
      const seatIds = hold.seat_ids;
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
      const seatCheck = await tx.query(
        `SELECT id, status, hold_id
         FROM seats
         WHERE id IN (${placeholders})
         FOR UPDATE`,
        seatIds
      );

      // Verify each seat is held by this hold
      for (const seat of seatCheck.rows) {
        if (seat.status !== "held" || seat.hold_id !== holdId) {
          return {
            error: "conflict",
            message: "Some seats are no longer held by this hold",
            expiredSeats: expiredSeats.rows,
          };
        }
      }

      // Step 4: Book the seats
      for (const seatId of seatIds) {
        await tx.query(
          `UPDATE seats
           SET status = 'booked',
               booked_by = $1,
               hold_expires_at = NULL
           WHERE id = $2`,
          [hold.session_id, seatId]
        );
      }

      // Mark hold as confirmed
      await tx.query(
        `UPDATE holds SET status = 'confirmed' WHERE id = $1`,
        [holdId]
      );

      // Fetch updated seats
      const updated = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
         FROM seats
         WHERE id IN (${placeholders})`,
        seatIds
      );

      return { success: true, alreadyConfirmed: false, seats: updated.rows, hold, expiredSeats: expiredSeats.rows };
    });

    // Broadcast any expired seats that were released during this transaction
    if (result.expiredSeats && result.expiredSeats.length > 0) {
      broadcast("seats-updated", result.expiredSeats.map((s) => ({
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

    if (result.error === "not_found") {
      return res.status(404).json({ error: "Hold not found" });
    }
    if (result.error === "expired") {
      return res.status(410).json({ error: result.message });
    }
    if (result.error === "conflict") {
      return res.status(409).json({ error: result.message });
    }

    // Broadcast only if this is the first confirmation
    if (!result.alreadyConfirmed) {
      broadcast("seats-updated", result.seats);
    }

    return res.json({
      holdId,
      status: "confirmed",
      seats: result.seats,
    });
  } catch (err) {
    console.error("POST /api/holds/:holdId/confirm error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// DELETE /api/holds/:holdId — release a hold early
// ============================================================================
router.delete("/holds/:holdId", async (req, res) => {
  const { holdId } = req.params;

  try {
    const db = await getDb();

    const result = await db.transaction(async (tx) => {
      // Find the hold
      const holdResult = await tx.query(
        `SELECT id, session_id, seat_ids, expires_at, status
         FROM holds
         WHERE id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        return { error: "not_found" };
      }

      const hold = holdResult.rows[0];

      // If already confirmed, cannot release
      if (hold.status === "confirmed") {
        return { error: "already_confirmed" };
      }

      // If already released or expired, idempotent success
      if (hold.status === "released" || hold.status === "expired") {
        return { success: true, alreadyReleased: true };
      }

      // Release the seats
      const seatIds = hold.seat_ids;
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");

      await tx.query(
        `UPDATE seats
         SET status = 'available',
             hold_id = NULL,
             hold_expires_at = NULL,
             session_id = NULL
         WHERE id IN (${placeholders})
           AND hold_id = $${seatIds.length + 1}`,
        [...seatIds, holdId]
      );

      await tx.query(
        `UPDATE holds SET status = 'released' WHERE id = $1`,
        [holdId]
      );

      // Fetch updated seats
      const updated = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
         FROM seats
         WHERE id IN (${placeholders})`,
        seatIds
      );

      return { success: true, alreadyReleased: false, seats: updated.rows };
    });

    if (result.error === "not_found") {
      return res.status(404).json({ error: "Hold not found" });
    }
    if (result.error === "already_confirmed") {
      return res.status(409).json({ error: "Hold is already confirmed and cannot be released" });
    }

    if (!result.alreadyReleased) {
      broadcast("seats-updated", result.seats);
    }

    return res.json({ holdId, status: "released" });
  } catch (err) {
    console.error("DELETE /api/holds/:holdId error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// GET /api/stream — SSE endpoint
// ============================================================================
router.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Send initial heartbeat
  res.write("event: connected\ndata: {}\n\n");

  addClient(res);

  // Send heartbeat every 15s to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write("event: heartbeat\ndata: {}\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
  });
});

// ============================================================================
// GET /api/inventory — debug endpoint for inventory counts
// ============================================================================
router.get("/inventory", async (req, res) => {
  try {
    await expireStaleHolds();

    const db = await getDb();
    const result = await db.query(`
      SELECT status, COUNT(*) as count
      FROM seats
      GROUP BY status
    `);

    const inventory = { available: 0, held: 0, booked: 0, total: 0 };
    for (const row of result.rows) {
      inventory[row.status] = parseInt(row.count, 10);
      inventory.total += parseInt(row.count, 10);
    }

    res.json(inventory);
  } catch (err) {
    console.error("GET /api/inventory error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
