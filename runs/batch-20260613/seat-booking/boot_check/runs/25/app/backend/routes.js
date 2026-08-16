import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import { addClient, broadcast } from "./sse.js";
import { expireStaleHolds } from "./expiry.js";

const router = Router();

const HOLD_TTL_SECONDS = 30; // 30 second hold TTL

// ─── SSE stream ───────────────────────────────────────────────
router.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("event: connected\ndata: {}\n\n");
  addClient(res);
});

// ─── Helper: get effective seat status ────────────────────────
function effectiveSeat(seat) {
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
}

// ─── GET /api/seats ───────────────────────────────────────────
router.get("/seats", async (_req, res) => {
  try {
    // Lazy expiry sweep before returning seats
    await expireStaleHolds();

    const db = await getDb();
    const result = await db.query(
      "SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by, session_id FROM seats ORDER BY row_label, seat_number"
    );
    const seats = result.rows.map(effectiveSeat);
    res.json(seats);
  } catch (err) {
    console.error("GET /seats error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /api/holds ──────────────────────────────────────────
router.post("/holds", async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: "seatIds must be a non-empty array" });
  }
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required" });
  }

  const db = await getDb();

  try {
    // Expire stale holds first
    await expireStaleHolds();

    // Use a transaction for atomicity
    // PGlite supports transactions via db.transaction()
    const holdId = uuidv4();
    const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

    const result = await db.transaction(async (tx) => {
      // Lock and check all requested seats
      // We SELECT ... FOR UPDATE to lock the rows. With PGlite being single-connection,
      // serialization is inherent, but we still use proper SQL patterns.
      const seatCheck = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
         FROM seats
         WHERE id = ANY($1)
         FOR UPDATE`,
        [seatIds]
      );

      if (seatCheck.rows.length !== seatIds.length) {
        const foundIds = seatCheck.rows.map((r) => r.id);
        const missing = seatIds.filter((id) => !foundIds.includes(id));
        return { error: true, status: 400, body: { error: "Unknown seat ids", seatIds: missing } };
      }

      // Check each seat is available (considering expired holds)
      const conflicts = [];
      for (const seat of seatCheck.rows) {
        const eff = effectiveSeat(seat);
        if (eff.status !== "available") {
          conflicts.push(seat.id);
        }
      }

      if (conflicts.length > 0) {
        return {
          error: true,
          status: 409,
          body: { error: "Seats unavailable", conflictingSeatIds: conflicts },
        };
      }

      // Release any expired holds on these seats before acquiring
      await tx.query(
        `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
         WHERE id = ANY($1) AND status = 'held' AND hold_expires_at <= NOW()`,
        [seatIds]
      );

      // Mark seats as held
      await tx.query(
        `UPDATE seats
         SET status = 'held', hold_id = $1, hold_expires_at = $2, session_id = $3
         WHERE id = ANY($4)`,
        [holdId, expiresAt, sessionId, seatIds]
      );

      // Create the hold record
      await tx.query(
        `INSERT INTO holds (id, session_id, seat_ids, expires_at, status)
         VALUES ($1, $2, $3, $4, 'active')`,
        [holdId, sessionId, seatIds, expiresAt]
      );

      // Fetch updated seats to broadcast
      const updated = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by, session_id
         FROM seats WHERE id = ANY($1)`,
        [seatIds]
      );

      return { error: false, holdId, expiresAt, seats: updated.rows };
    });

    if (result.error) {
      return res.status(result.status).json(result.body);
    }

    // Broadcast seat updates
    broadcast(
      "seat-update",
      result.seats.map((s) => ({
        id: s.id,
        row_label: s.row_label,
        seat_number: s.seat_number,
        status: s.status,
        hold_id: s.hold_id,
        hold_expires_at: s.hold_expires_at,
        session_id: s.session_id,
        booked_by: s.booked_by,
      }))
    );

    res.status(201).json({
      holdId: result.holdId,
      expiresAt: result.expiresAt,
      seatIds,
    });
  } catch (err) {
    console.error("POST /holds error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /api/holds/:holdId/confirm ──────────────────────────
router.post("/holds/:holdId/confirm", async (req, res) => {
  const { holdId } = req.params;
  const db = await getDb();

  try {
    // Expire stale holds first
    await expireStaleHolds();

    const result = await db.transaction(async (tx) => {
      // Get the hold
      const holdResult = await tx.query(
        "SELECT id, session_id, seat_ids, expires_at, status FROM holds WHERE id = $1",
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        return { error: true, status: 404, body: { error: "Hold not found" } };
      }

      const hold = holdResult.rows[0];

      // Idempotent: if already confirmed, return success
      if (hold.status === "confirmed") {
        const bookedSeats = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by, session_id
           FROM seats WHERE id = ANY($1)`,
          [hold.seat_ids]
        );
        return {
          error: false,
          alreadyConfirmed: true,
          holdId: hold.id,
          sessionId: hold.session_id,
          seats: bookedSeats.rows,
        };
      }

      // Check if expired
      if (hold.status === "expired" || new Date(hold.expires_at) <= new Date()) {
        // Mark as expired if not already
        if (hold.status === "active") {
          await tx.query("UPDATE holds SET status = 'expired' WHERE id = $1", [holdId]);
          // Release the seats
          await tx.query(
            `UPDATE seats
             SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
             WHERE hold_id = $1 AND status = 'held'`,
            [holdId]
          );
        }
        return { error: true, status: 410, body: { error: "Hold expired" } };
      }

      // Check if released
      if (hold.status === "released") {
        return { error: true, status: 410, body: { error: "Hold was released" } };
      }

      // Verify all seats are still held by this hold
      const seatCheck = await tx.query(
        `SELECT id, status, hold_id FROM seats
         WHERE id = ANY($1) FOR UPDATE`,
        [hold.seat_ids]
      );

      for (const seat of seatCheck.rows) {
        if (seat.status !== "held" || seat.hold_id !== holdId) {
          // Seat was tampered with - should not happen but safety check
          return {
            error: true,
            status: 409,
            body: { error: "Seat state inconsistency detected", seatId: seat.id },
          };
        }
      }

      // Mark seats as booked
      await tx.query(
        `UPDATE seats
         SET status = 'booked', booked_by = $1, hold_expires_at = NULL
         WHERE id = ANY($2) AND hold_id = $3`,
        [hold.session_id, hold.seat_ids, holdId]
      );

      // Mark hold as confirmed
      await tx.query("UPDATE holds SET status = 'confirmed' WHERE id = $1", [holdId]);

      // Fetch updated seats
      const updated = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by, session_id
         FROM seats WHERE id = ANY($1)`,
        [hold.seat_ids]
      );

      return {
        error: false,
        alreadyConfirmed: false,
        holdId: hold.id,
        sessionId: hold.session_id,
        seats: updated.rows,
      };
    });

    if (result.error) {
      return res.status(result.status).json(result.body);
    }

    // Broadcast only if this is a new confirmation (not idempotent repeat)
    if (!result.alreadyConfirmed) {
      broadcast(
        "seat-update",
        result.seats.map((s) => ({
          id: s.id,
          row_label: s.row_label,
          seat_number: s.seat_number,
          status: s.status,
          hold_id: s.hold_id,
          hold_expires_at: s.hold_expires_at,
          session_id: s.session_id,
          booked_by: s.booked_by,
        }))
      );
    }

    res.json({
      holdId: result.holdId,
      sessionId: result.sessionId,
      seatIds: result.seats.map((s) => s.id),
      status: "confirmed",
    });
  } catch (err) {
    console.error("POST /holds/:holdId/confirm error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── DELETE /api/holds/:holdId ────────────────────────────────
router.delete("/holds/:holdId", async (req, res) => {
  const { holdId } = req.params;
  const db = await getDb();

  try {
    const result = await db.transaction(async (tx) => {
      const holdResult = await tx.query(
        "SELECT id, session_id, seat_ids, expires_at, status FROM holds WHERE id = $1",
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        return { error: true, status: 404, body: { error: "Hold not found" } };
      }

      const hold = holdResult.rows[0];

      // Can't release a confirmed hold
      if (hold.status === "confirmed") {
        return { error: true, status: 400, body: { error: "Cannot release a confirmed hold" } };
      }

      // Already released or expired - idempotent
      if (hold.status === "released" || hold.status === "expired") {
        return { error: false, alreadyReleased: true, seats: [] };
      }

      // Release the seats
      const updated = await tx.query(
        `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
         WHERE hold_id = $1 AND status = 'held'
         RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by, session_id`,
        [holdId]
      );

      // Mark hold as released
      await tx.query("UPDATE holds SET status = 'released' WHERE id = $1", [holdId]);

      return { error: false, alreadyReleased: false, seats: updated.rows };
    });

    if (result.error) {
      return res.status(result.status).json(result.body);
    }

    if (!result.alreadyReleased && result.seats.length > 0) {
      broadcast(
        "seat-update",
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

// ─── GET /api/inventory ───────────────────────────────────────
router.get("/inventory", async (_req, res) => {
  try {
    await expireStaleHolds();
    const db = await getDb();
    const result = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'available' OR (status = 'held' AND hold_expires_at <= NOW()))::int AS available,
        COUNT(*) FILTER (WHERE status = 'held' AND hold_expires_at > NOW())::int AS held,
        COUNT(*) FILTER (WHERE status = 'booked')::int AS booked,
        COUNT(*)::int AS total
      FROM seats
    `);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET /inventory error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
