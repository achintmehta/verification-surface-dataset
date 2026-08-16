import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import { addClient, broadcast } from "./sse.js";
import { expireStaleHolds } from "./expiry.js";

const router = Router();

const HOLD_TTL_SECONDS = 30;

// ─── SSE Endpoint ─────────────────────────────────────────────────
router.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(":\n\n"); // comment to establish connection
  addClient(res);
});

// ─── Get all seats ────────────────────────────────────────────────
router.get("/seats", async (req, res) => {
  try {
    // Expire stale holds first
    await expireStaleHolds();

    const db = await getDb();
    const result = await db.query(`
      SELECT
        id,
        row_label,
        seat_number,
        CASE
          WHEN status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at <= NOW()
            THEN 'available'
          ELSE status
        END AS status,
        CASE
          WHEN status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at > NOW()
            THEN hold_id
          ELSE NULL
        END AS hold_id,
        CASE
          WHEN status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at > NOW()
            THEN hold_expires_at
          ELSE NULL
        END AS hold_expires_at,
        CASE
          WHEN status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at > NOW()
            THEN session_id
          WHEN status = 'booked'
            THEN session_id
          ELSE NULL
        END AS session_id,
        booked_by
      FROM seats
      ORDER BY row_label, seat_number
    `);

    res.json({ seats: result.rows });
  } catch (e) {
    console.error("GET /api/seats error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Get inventory counts ─────────────────────────────────────────
router.get("/inventory", async (req, res) => {
  try {
    await expireStaleHolds();

    const db = await getDb();
    const result = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE
          status = 'available' OR
          (status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at <= NOW())
        ) AS available,
        COUNT(*) FILTER (WHERE
          status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at > NOW()
        ) AS held,
        COUNT(*) FILTER (WHERE status = 'booked') AS booked,
        COUNT(*) AS total
      FROM seats
    `);

    res.json(result.rows[0]);
  } catch (e) {
    console.error("GET /api/inventory error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Create a hold ────────────────────────────────────────────────
router.post("/holds", async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
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
    const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

    // Use a transaction with explicit locking to prevent races
    // PGLite is single-connection, but we still need atomicity
    // We'll use BEGIN/COMMIT with row-level checks

    await db.query("BEGIN");

    try {
      // Check all requested seats are available within the transaction
      // Build parameterized query for seat IDs
      const placeholders = uniqueSeatIds.map((_, i) => `$${i + 1}`).join(", ");
      const checkResult = await db.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
         FROM seats
         WHERE id IN (${placeholders})
         FOR UPDATE`,
        uniqueSeatIds
      );

      if (checkResult.rows.length !== uniqueSeatIds.length) {
        await db.query("ROLLBACK");
        return res.status(400).json({ error: "Some seat IDs are invalid" });
      }

      // Check which seats are unavailable (held with non-expired hold, or booked)
      const conflicting = [];
      for (const seat of checkResult.rows) {
        if (seat.status === "booked") {
          conflicting.push({
            id: seat.id,
            row_label: seat.row_label,
            seat_number: seat.seat_number,
            reason: "booked",
          });
        } else if (
          seat.status === "held" &&
          seat.hold_expires_at &&
          new Date(seat.hold_expires_at) > new Date()
        ) {
          conflicting.push({
            id: seat.id,
            row_label: seat.row_label,
            seat_number: seat.seat_number,
            reason: "held",
          });
        }
      }

      if (conflicting.length > 0) {
        await db.query("ROLLBACK");
        return res.status(409).json({
          error: "Some seats are unavailable",
          conflicting,
        });
      }

      // All seats are available — acquire them
      const updatePlaceholders = uniqueSeatIds
        .map((_, i) => `$${i + 4}`)
        .join(", ");
      await db.query(
        `UPDATE seats
         SET status = 'held',
             hold_id = $1,
             hold_expires_at = $2::timestamptz,
             session_id = $3
         WHERE id IN (${updatePlaceholders})`,
        [holdId, expiresAt, sessionId, ...uniqueSeatIds]
      );

      // Create hold record
      await db.query(
        `INSERT INTO holds (id, session_id, seat_ids, expires_at, status)
         VALUES ($1, $2, $3, $4::timestamptz, 'active')`,
        [holdId, sessionId, uniqueSeatIds, expiresAt]
      );

      await db.query("COMMIT");

      // Fetch updated seats for response and broadcast
      const updatedSeats = await db.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id
         FROM seats WHERE id IN (${placeholders})`,
        uniqueSeatIds
      );

      // Broadcast
      broadcast("seats-updated", updatedSeats.rows);

      return res.status(201).json({
        holdId,
        sessionId,
        expiresAt,
        seats: updatedSeats.rows,
      });
    } catch (txErr) {
      await db.query("ROLLBACK");
      throw txErr;
    }
  } catch (e) {
    console.error("POST /api/holds error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Confirm a hold ───────────────────────────────────────────────
router.post("/holds/:holdId/confirm", async (req, res) => {
  const { holdId } = req.params;

  try {
    const db = await getDb();

    // Expire stale holds first
    await expireStaleHolds();

    await db.query("BEGIN");

    try {
      // Look up the hold
      const holdResult = await db.query(
        `SELECT id, session_id, seat_ids, expires_at, status, confirmed_at
         FROM holds
         WHERE id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        await db.query("ROLLBACK");
        return res.status(404).json({ error: "Hold not found" });
      }

      const hold = holdResult.rows[0];

      // Idempotent: if already confirmed, return success with the same data
      if (hold.status === "confirmed") {
        await db.query("ROLLBACK");

        const seatIds = hold.seat_ids;
        const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
        const seatsResult = await db.query(
          `SELECT id, row_label, seat_number, status, session_id, booked_by
           FROM seats WHERE id IN (${placeholders})`,
          seatIds
        );

        return res.json({
          holdId: hold.id,
          sessionId: hold.session_id,
          status: "confirmed",
          confirmedAt: hold.confirmed_at,
          seats: seatsResult.rows,
        });
      }

      // Check if expired
      if (hold.status === "expired" || new Date(hold.expires_at) <= new Date()) {
        // Mark as expired if not already
        await db.query(
          `UPDATE holds SET status = 'expired' WHERE id = $1 AND status = 'active'`,
          [holdId]
        );

        // Release any seats that might still be held by this hold
        await db.query(
          `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
           WHERE hold_id = $1 AND status = 'held'`,
          [holdId]
        );

        await db.query("COMMIT");
        return res.status(410).json({ error: "Hold has expired" });
      }

      // Check if released
      if (hold.status === "released") {
        await db.query("ROLLBACK");
        return res.status(410).json({ error: "Hold was released" });
      }

      // Verify the seats are still held by this hold
      const seatIds = hold.seat_ids;
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
      const seatsCheck = await db.query(
        `SELECT id, status, hold_id
         FROM seats
         WHERE id IN (${placeholders})
         FOR UPDATE`,
        seatIds
      );

      // Verify all seats are held by this hold
      const allHeldByUs = seatsCheck.rows.every(
        (s) => s.status === "held" && s.hold_id === holdId
      );

      if (!allHeldByUs) {
        // Something went wrong — the hold is invalid
        await db.query(
          `UPDATE holds SET status = 'expired' WHERE id = $1`,
          [holdId]
        );
        await db.query("COMMIT");
        return res.status(409).json({
          error: "Hold is no longer valid — some seats have changed state",
        });
      }

      // Confirm: mark seats as booked
      const updatePlaceholders = seatIds
        .map((_, i) => `$${i + 3}`)
        .join(", ");
      await db.query(
        `UPDATE seats
         SET status = 'booked',
             booked_by = $1,
             hold_id = $2,
             hold_expires_at = NULL
         WHERE id IN (${updatePlaceholders})`,
        [hold.session_id, holdId, ...seatIds]
      );

      // Update hold status to confirmed
      await db.query(
        `UPDATE holds SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1`,
        [holdId]
      );

      await db.query("COMMIT");

      // Fetch updated seats
      const updatedSeats = await db.query(
        `SELECT id, row_label, seat_number, status, session_id, booked_by, hold_id
         FROM seats WHERE id IN (${placeholders})`,
        seatIds
      );

      // Broadcast
      broadcast("seats-updated", updatedSeats.rows);

      return res.json({
        holdId: hold.id,
        sessionId: hold.session_id,
        status: "confirmed",
        seats: updatedSeats.rows,
      });
    } catch (txErr) {
      await db.query("ROLLBACK");
      throw txErr;
    }
  } catch (e) {
    console.error("POST /api/holds/:holdId/confirm error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Release a hold ───────────────────────────────────────────────
router.delete("/holds/:holdId", async (req, res) => {
  const { holdId } = req.params;

  try {
    const db = await getDb();

    await db.query("BEGIN");

    try {
      const holdResult = await db.query(
        `SELECT id, session_id, seat_ids, status
         FROM holds
         WHERE id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        await db.query("ROLLBACK");
        return res.status(404).json({ error: "Hold not found" });
      }

      const hold = holdResult.rows[0];

      if (hold.status === "confirmed") {
        await db.query("ROLLBACK");
        return res.status(400).json({ error: "Cannot release a confirmed hold" });
      }

      if (hold.status === "released") {
        await db.query("ROLLBACK");
        return res.json({ message: "Hold already released" });
      }

      // Release seats
      const seatIds = hold.seat_ids;
      const placeholders = seatIds.map((_, i) => `$${i + 2}`).join(", ");
      await db.query(
        `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
         WHERE hold_id = $1 AND id IN (${placeholders})`,
        [holdId, ...seatIds]
      );

      // Update hold
      await db.query(
        `UPDATE holds SET status = 'released' WHERE id = $1`,
        [holdId]
      );

      await db.query("COMMIT");

      // Fetch updated seats for broadcast
      const seatPlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
      const updatedSeats = await db.query(
        `SELECT id, row_label, seat_number, status, hold_id, session_id
         FROM seats WHERE id IN (${seatPlaceholders})`,
        seatIds
      );

      broadcast("seats-updated", updatedSeats.rows);

      return res.json({ message: "Hold released", seats: updatedSeats.rows });
    } catch (txErr) {
      await db.query("ROLLBACK");
      throw txErr;
    }
  } catch (e) {
    console.error("DELETE /api/holds/:holdId error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
