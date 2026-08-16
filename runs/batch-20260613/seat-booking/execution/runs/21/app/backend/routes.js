import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import { addClient, broadcast } from "./sse.js";
import { expireStaleHolds } from "./expiry.js";

const router = Router();

const HOLD_TTL_SECONDS = 30; // 30 seconds TTL for holds

// ---------- SSE endpoint ----------
router.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`event: connected\ndata: {}\n\n`);
  addClient(res);
});

// ---------- GET /api/seats ----------
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

    // Map effective status: if held but expired, show as available
    const seats = result.rows.map((s) => {
      if (
        s.status === "held" &&
        s.hold_expires_at &&
        new Date(s.hold_expires_at) <= new Date()
      ) {
        return {
          ...s,
          status: "available",
          hold_id: null,
          hold_expires_at: null,
          session_id: null,
        };
      }
      return s;
    });

    res.json({ seats });
  } catch (err) {
    console.error("GET /seats error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- POST /api/holds ----------
router.post("/holds", async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (
    !seatIds ||
    !Array.isArray(seatIds) ||
    seatIds.length === 0 ||
    !sessionId
  ) {
    return res
      .status(400)
      .json({ error: "seatIds (non-empty array) and sessionId are required" });
  }

  const db = await getDb();

  try {
    // Use a transaction for atomicity
    const holdId = uuidv4();
    const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

    const result = await db.transaction(async (tx) => {
      // First, expire any stale holds within this transaction
      await tx.query(`
        UPDATE seats
        SET status = 'available',
            hold_id = NULL,
            hold_expires_at = NULL,
            session_id = NULL
        WHERE status = 'held'
          AND hold_expires_at IS NOT NULL
          AND hold_expires_at <= NOW()
      `);

      await tx.query(`
        UPDATE holds
        SET status = 'expired'
        WHERE status = 'active'
          AND expires_at <= NOW()
      `);

      // Check all requested seats are available
      // Build parameterized query for seat ids
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
      const checkResult = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, session_id
         FROM seats
         WHERE id IN (${placeholders})
         FOR UPDATE`,
        seatIds
      );

      if (checkResult.rows.length !== seatIds.length) {
        const foundIds = new Set(checkResult.rows.map((r) => r.id));
        const missing = seatIds.filter((id) => !foundIds.has(id));
        return {
          conflict: true,
          statusCode: 400,
          error: "Some seat ids do not exist",
          missingIds: missing,
        };
      }

      const conflicting = checkResult.rows.filter(
        (r) => r.status !== "available"
      );
      if (conflicting.length > 0) {
        return {
          conflict: true,
          statusCode: 409,
          error: "Some seats are not available",
          conflictingSeatIds: conflicting.map((r) => r.id),
        };
      }

      // All seats available — acquire them
      const updatePlaceholders = seatIds
        .map((_, i) => `$${i + 4}`)
        .join(", ");
      await tx.query(
        `UPDATE seats
         SET status = 'held',
             hold_id = $1,
             hold_expires_at = $2,
             session_id = $3
         WHERE id IN (${updatePlaceholders})`,
        [holdId, expiresAt.toISOString(), sessionId, ...seatIds]
      );

      // Create hold record
      await tx.query(
        `INSERT INTO holds (id, session_id, seat_ids, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [holdId, sessionId, seatIds, expiresAt.toISOString()]
      );

      return { conflict: false };
    });

    if (result.conflict) {
      return res.status(result.statusCode).json({
        error: result.error,
        conflictingSeatIds: result.conflictingSeatIds,
        missingIds: result.missingIds,
      });
    }

    // Fetch the held seats for response and broadcast
    const heldSeats = await db.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id
       FROM seats WHERE hold_id = $1`,
      [holdId]
    );

    // Broadcast the hold
    broadcast(
      "seats-updated",
      heldSeats.rows.map((s) => ({
        id: s.id,
        row_label: s.row_label,
        seat_number: s.seat_number,
        status: s.status,
        hold_id: s.hold_id,
        hold_expires_at: s.hold_expires_at,
        session_id: s.session_id,
        booked_by: null,
      }))
    );

    // Also broadcast any seats that were expired in the transaction
    // (we already broadcast from the sweep, and the full seat list on GET)
    // The periodic sweep handles broadcasting expired seats

    res.status(201).json({
      hold: {
        id: holdId,
        sessionId,
        seatIds,
        expiresAt: expiresAt.toISOString(),
      },
    });
  } catch (err) {
    console.error("POST /holds error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- POST /api/holds/:holdId/confirm ----------
router.post("/holds/:holdId/confirm", async (req, res) => {
  const { holdId } = req.params;
  const db = await getDb();

  try {
    const result = await db.transaction(async (tx) => {
      // Expire stale holds first
      await tx.query(`
        UPDATE seats
        SET status = 'available',
            hold_id = NULL,
            hold_expires_at = NULL,
            session_id = NULL
        WHERE status = 'held'
          AND hold_expires_at IS NOT NULL
          AND hold_expires_at <= NOW()
      `);

      await tx.query(`
        UPDATE holds
        SET status = 'expired'
        WHERE status = 'active'
          AND expires_at <= NOW()
      `);

      // Fetch the hold
      const holdResult = await tx.query(
        `SELECT id, session_id, seat_ids, expires_at, status, confirmed_at
         FROM holds WHERE id = $1`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        return { error: true, statusCode: 404, message: "Hold not found" };
      }

      const hold = holdResult.rows[0];

      // Idempotency: if already confirmed, return success
      if (hold.status === "confirmed") {
        const bookedSeats = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id, booked_by, session_id
           FROM seats WHERE booked_by = $1`,
          [holdId]
        );
        return {
          error: false,
          idempotent: true,
          seats: bookedSeats.rows,
          hold,
        };
      }

      // Check if expired or released
      if (hold.status === "expired" || hold.status === "released") {
        return {
          error: true,
          statusCode: 410,
          message: `Hold has ${hold.status}`,
        };
      }

      // Check expiry by time (in case sweep hasn't run)
      if (new Date(hold.expires_at) <= new Date()) {
        // Mark as expired
        await tx.query(
          `UPDATE holds SET status = 'expired' WHERE id = $1`,
          [holdId]
        );
        await tx.query(
          `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
           WHERE hold_id = $1 AND status = 'held'`,
          [holdId]
        );
        return { error: true, statusCode: 410, message: "Hold has expired" };
      }

      // Verify the seats are still held by this hold
      const seatIds = hold.seat_ids;
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
      const seatsCheck = await tx.query(
        `SELECT id, status, hold_id FROM seats
         WHERE id IN (${placeholders})
         FOR UPDATE`,
        seatIds
      );

      const notHeldByUs = seatsCheck.rows.filter(
        (s) => s.status !== "held" || s.hold_id !== holdId
      );

      if (notHeldByUs.length > 0) {
        // Something went wrong — the seats are no longer held by this hold
        return {
          error: true,
          statusCode: 409,
          message: "Some seats are no longer held by this hold",
        };
      }

      // Book the seats
      await tx.query(
        `UPDATE seats
         SET status = 'booked',
             booked_by = $1,
             hold_expires_at = NULL
         WHERE hold_id = $2`,
        [holdId, holdId]
      );

      // Update the hold
      await tx.query(
        `UPDATE holds SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1`,
        [holdId]
      );

      const bookedSeats = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, booked_by, session_id
         FROM seats WHERE booked_by = $1`,
        [holdId]
      );

      return { error: false, idempotent: false, seats: bookedSeats.rows, hold };
    });

    if (result.error) {
      return res
        .status(result.statusCode)
        .json({ error: result.message });
    }

    // Broadcast booked seats (only if not idempotent replay)
    if (!result.idempotent) {
      broadcast(
        "seats-updated",
        result.seats.map((s) => ({
          id: s.id,
          row_label: s.row_label,
          seat_number: s.seat_number,
          status: "booked",
          hold_id: s.hold_id,
          hold_expires_at: null,
          session_id: s.session_id,
          booked_by: s.booked_by,
        }))
      );
    }

    res.json({
      booking: {
        holdId,
        seats: result.seats.map((s) => ({
          id: s.id,
          row_label: s.row_label,
          seat_number: s.seat_number,
        })),
        confirmedAt: result.hold.confirmed_at || new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("POST /holds/:holdId/confirm error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- DELETE /api/holds/:holdId ----------
router.delete("/holds/:holdId", async (req, res) => {
  const { holdId } = req.params;
  const db = await getDb();

  try {
    const result = await db.transaction(async (tx) => {
      const holdResult = await tx.query(
        `SELECT id, session_id, seat_ids, status FROM holds WHERE id = $1`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        return { error: true, statusCode: 404, message: "Hold not found" };
      }

      const hold = holdResult.rows[0];

      if (hold.status === "confirmed") {
        return {
          error: true,
          statusCode: 400,
          message: "Cannot release a confirmed hold",
        };
      }

      if (hold.status === "released" || hold.status === "expired") {
        // Idempotent: already released
        return { error: false, alreadyReleased: true, seats: [] };
      }

      // Release the seats
      const releasedSeats = await tx.query(
        `UPDATE seats
         SET status = 'available',
             hold_id = NULL,
             hold_expires_at = NULL,
             session_id = NULL
         WHERE hold_id = $1 AND status = 'held'
         RETURNING id, row_label, seat_number`,
        [holdId]
      );

      await tx.query(
        `UPDATE holds SET status = 'released' WHERE id = $1`,
        [holdId]
      );

      return {
        error: false,
        alreadyReleased: false,
        seats: releasedSeats.rows,
      };
    });

    if (result.error) {
      return res
        .status(result.statusCode)
        .json({ error: result.message });
    }

    if (!result.alreadyReleased && result.seats.length > 0) {
      broadcast(
        "seats-updated",
        result.seats.map((s) => ({
          id: s.id,
          row_label: s.row_label,
          seat_number: s.seat_number,
          status: "available",
          hold_id: null,
          hold_expires_at: null,
          session_id: null,
          booked_by: null,
        }))
      );
    }

    res.json({ released: true });
  } catch (err) {
    console.error("DELETE /holds/:holdId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
