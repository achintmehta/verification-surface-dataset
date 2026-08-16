import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import { addClient, broadcast } from "./sse.js";
import { sweepExpiredHolds } from "./expiry.js";

const router = Router();

const HOLD_TTL_SECONDS = 30; // 30 second hold TTL

// ─── SSE Stream ───────────────────────────────────────────────────────────────
router.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`event: connected\ndata: {}\n\n`);
  addClient(res);

  // Send a heartbeat every 15s to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(`:heartbeat\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
  });
});

// ─── GET /seats ───────────────────────────────────────────────────────────────
router.get("/seats", async (req, res) => {
  try {
    // Sweep expired holds first
    await sweepExpiredHolds();

    const db = await getDb();
    const result = await db.query(`
      SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by,
        CASE
          WHEN status = 'held' AND hold_expires_at <= NOW() THEN 'available'
          ELSE status
        END AS effective_status
      FROM seats
      ORDER BY row_label, seat_number
    `);

    const seats = result.rows.map((row) => ({
      id: row.id,
      rowLabel: row.row_label,
      seatNumber: row.seat_number,
      status: row.effective_status,
      holdId: row.effective_status === "available" ? null : row.hold_id,
      holdExpiresAt:
        row.effective_status === "held" ? row.hold_expires_at : null,
      sessionId:
        row.effective_status === "available" ? null : row.session_id,
      bookedBy: row.booked_by,
    }));

    res.json({ seats });
  } catch (err) {
    console.error("GET /seats error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /holds ──────────────────────────────────────────────────────────────
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

  // Validate seatIds are integers
  const parsedSeatIds = seatIds.map((id) => parseInt(id, 10));
  if (parsedSeatIds.some((id) => isNaN(id))) {
    return res.status(400).json({ error: "All seatIds must be integers" });
  }

  const db = await getDb();
  const holdId = uuidv4();

  await db.exec("BEGIN");

  try {
    // First, expire any stale holds atomically
    await db.query(`
      UPDATE seats
      SET status = 'available',
          hold_id = NULL,
          hold_expires_at = NULL,
          session_id = NULL
      WHERE status = 'held'
        AND hold_expires_at IS NOT NULL
        AND hold_expires_at <= NOW()
    `);

    await db.query(`
      UPDATE holds
      SET status = 'expired'
      WHERE status = 'active'
        AND expires_at <= NOW()
    `);

    // Lock and check availability of all requested seats
    const lockResult = await db.query(
      `SELECT id, row_label, seat_number, status, hold_id
       FROM seats
       WHERE id = ANY($1::int[])
       FOR UPDATE`,
      [parsedSeatIds]
    );

    if (lockResult.rows.length !== parsedSeatIds.length) {
      await db.exec("ROLLBACK");
      return res.status(400).json({ error: "One or more seat IDs are invalid" });
    }

    // Check which seats are not available
    const unavailable = lockResult.rows.filter(
      (row) => row.status !== "available"
    );

    if (unavailable.length > 0) {
      await db.exec("ROLLBACK");
      return res.status(409).json({
        error: "Some seats are not available",
        conflictingSeatIds: unavailable.map((r) => r.id),
      });
    }

    // All seats are available — place the hold
    const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

    await db.query(
      `UPDATE seats
       SET status = 'held',
           hold_id = $1,
           hold_expires_at = $2,
           session_id = $3
       WHERE id = ANY($4::int[])`,
      [holdId, expiresAt.toISOString(), sessionId, parsedSeatIds]
    );

    // Create the hold record
    await db.query(
      `INSERT INTO holds (id, session_id, seat_ids, expires_at, status)
       VALUES ($1, $2, $3::int[], $4, 'active')`,
      [holdId, sessionId, parsedSeatIds, expiresAt.toISOString()]
    );

    await db.exec("COMMIT");

    // Fetch updated seats for broadcast
    const updatedSeats = await db.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
       FROM seats
       WHERE id = ANY($1::int[])`,
      [parsedSeatIds]
    );

    const seatData = updatedSeats.rows.map((r) => ({
      id: r.id,
      rowLabel: r.row_label,
      seatNumber: r.seat_number,
      status: r.status,
      holdId: r.hold_id,
      holdExpiresAt: r.hold_expires_at,
      sessionId: r.session_id,
      bookedBy: r.booked_by,
    }));

    broadcast("seats-updated", seatData);

    res.status(201).json({
      holdId,
      sessionId,
      seatIds: parsedSeatIds,
      expiresAt: expiresAt.toISOString(),
      ttlSeconds: HOLD_TTL_SECONDS,
      seats: seatData,
    });
  } catch (err) {
    await db.exec("ROLLBACK");
    console.error("POST /holds error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /holds/:holdId/confirm ─────────────────────────────────────────────
router.post("/holds/:holdId/confirm", async (req, res) => {
  const { holdId } = req.params;
  const db = await getDb();

  await db.exec("BEGIN");

  try {
    // Lock the hold record
    const holdResult = await db.query(
      `SELECT id, session_id, seat_ids, expires_at, status, confirmed_at
       FROM holds
       WHERE id = $1
       FOR UPDATE`,
      [holdId]
    );

    if (holdResult.rows.length === 0) {
      await db.exec("ROLLBACK");
      return res.status(404).json({ error: "Hold not found" });
    }

    const hold = holdResult.rows[0];

    // Idempotent: if already confirmed, return the same result
    if (hold.status === "confirmed") {
      await db.exec("ROLLBACK");

      const bookedSeats = await db.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
         FROM seats
         WHERE id = ANY($1::int[])`,
        [hold.seat_ids]
      );

      const seatData = bookedSeats.rows.map((r) => ({
        id: r.id,
        rowLabel: r.row_label,
        seatNumber: r.seat_number,
        status: r.status,
        holdId: r.hold_id,
        holdExpiresAt: r.hold_expires_at,
        sessionId: r.session_id,
        bookedBy: r.booked_by,
      }));

      return res.json({
        holdId: hold.id,
        sessionId: hold.session_id,
        seatIds: hold.seat_ids,
        status: "confirmed",
        confirmedAt: hold.confirmed_at,
        seats: seatData,
      });
    }

    // Check if hold is expired or released
    if (hold.status === "expired" || hold.status === "released") {
      await db.exec("ROLLBACK");
      return res.status(410).json({
        error: `Hold has been ${hold.status}`,
        holdId: hold.id,
      });
    }

    // Check if hold is past TTL
    const now = new Date();
    const expiresAt = new Date(hold.expires_at);
    if (now > expiresAt) {
      // Mark as expired
      await db.query(
        `UPDATE holds SET status = 'expired' WHERE id = $1`,
        [holdId]
      );

      // Release the seats
      await db.query(
        `UPDATE seats
         SET status = 'available',
             hold_id = NULL,
             hold_expires_at = NULL,
             session_id = NULL
         WHERE hold_id = $1 AND status = 'held'`,
        [holdId]
      );

      await db.exec("COMMIT");

      // Broadcast released seats
      const releasedSeats = await db.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
         FROM seats WHERE id = ANY($1::int[])`,
        [hold.seat_ids]
      );

      broadcast(
        "seats-updated",
        releasedSeats.rows.map((r) => ({
          id: r.id,
          rowLabel: r.row_label,
          seatNumber: r.seat_number,
          status: r.status,
          holdId: r.hold_id,
          holdExpiresAt: r.hold_expires_at,
          sessionId: r.session_id,
          bookedBy: r.booked_by,
        }))
      );

      return res.status(410).json({
        error: "Hold has expired",
        holdId: hold.id,
      });
    }

    // Verify seats are still held by this hold
    const seatResult = await db.query(
      `SELECT id, status, hold_id
       FROM seats
       WHERE id = ANY($1::int[])
       FOR UPDATE`,
      [hold.seat_ids]
    );

    const allOwned = seatResult.rows.every(
      (r) => r.status === "held" && r.hold_id === holdId
    );

    if (!allOwned) {
      await db.exec("ROLLBACK");
      return res.status(409).json({
        error: "Hold seats are no longer valid",
        holdId: hold.id,
      });
    }

    // Confirm: mark seats as booked
    const confirmedAt = new Date().toISOString();

    await db.query(
      `UPDATE seats
       SET status = 'booked',
           booked_by = $1
       WHERE id = ANY($2::int[])`,
      [hold.session_id, hold.seat_ids]
    );

    await db.query(
      `UPDATE holds
       SET status = 'confirmed', confirmed_at = $1
       WHERE id = $2`,
      [confirmedAt, holdId]
    );

    await db.exec("COMMIT");

    // Fetch and broadcast
    const bookedSeats = await db.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
       FROM seats
       WHERE id = ANY($1::int[])`,
      [hold.seat_ids]
    );

    const seatData = bookedSeats.rows.map((r) => ({
      id: r.id,
      rowLabel: r.row_label,
      seatNumber: r.seat_number,
      status: r.status,
      holdId: r.hold_id,
      holdExpiresAt: r.hold_expires_at,
      sessionId: r.session_id,
      bookedBy: r.booked_by,
    }));

    broadcast("seats-updated", seatData);

    res.json({
      holdId: hold.id,
      sessionId: hold.session_id,
      seatIds: hold.seat_ids,
      status: "confirmed",
      confirmedAt,
      seats: seatData,
    });
  } catch (err) {
    await db.exec("ROLLBACK");
    console.error("POST /holds/:holdId/confirm error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── DELETE /holds/:holdId ───────────────────────────────────────────────────
router.delete("/holds/:holdId", async (req, res) => {
  const { holdId } = req.params;
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
      return res.status(404).json({ error: "Hold not found" });
    }

    const hold = holdResult.rows[0];

    if (hold.status !== "active") {
      await db.exec("ROLLBACK");
      return res.status(410).json({
        error: `Hold is already ${hold.status}`,
        holdId: hold.id,
      });
    }

    // Release the seats
    await db.query(
      `UPDATE seats
       SET status = 'available',
           hold_id = NULL,
           hold_expires_at = NULL,
           session_id = NULL
       WHERE hold_id = $1 AND status = 'held'`,
      [holdId]
    );

    await db.query(
      `UPDATE holds SET status = 'released' WHERE id = $1`,
      [holdId]
    );

    await db.exec("COMMIT");

    // Fetch and broadcast
    const releasedSeats = await db.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
       FROM seats WHERE id = ANY($1::int[])`,
      [hold.seat_ids]
    );

    const seatData = releasedSeats.rows.map((r) => ({
      id: r.id,
      rowLabel: r.row_label,
      seatNumber: r.seat_number,
      status: r.status,
      holdId: r.hold_id,
      holdExpiresAt: r.hold_expires_at,
      sessionId: r.session_id,
      bookedBy: r.booked_by,
    }));

    broadcast("seats-updated", seatData);

    res.json({
      holdId: hold.id,
      status: "released",
      seatIds: hold.seat_ids,
      seats: seatData,
    });
  } catch (err) {
    await db.exec("ROLLBACK");
    console.error("DELETE /holds/:holdId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /inventory ──────────────────────────────────────────────────────────
router.get("/inventory", async (req, res) => {
  try {
    await sweepExpiredHolds();
    const db = await getDb();

    const result = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE
          CASE
            WHEN status = 'held' AND hold_expires_at <= NOW() THEN 'available'
            ELSE status
          END = 'available'
        ) AS available,
        COUNT(*) FILTER (WHERE
          CASE
            WHEN status = 'held' AND hold_expires_at <= NOW() THEN 'available'
            ELSE status
          END = 'held'
        ) AS held,
        COUNT(*) FILTER (WHERE status = 'booked') AS booked,
        COUNT(*) AS total
      FROM seats
    `);

    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET /inventory error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
