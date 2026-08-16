import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import { addClient, broadcast } from "./sse.js";
import { expireStaleHolds } from "./expiry.js";

const router = Router();

const HOLD_TTL_SECONDS = parseInt(process.env.HOLD_TTL_SECONDS || "30", 10); // configurable hold TTL

/**
 * Parse seat_ids from the holds table. Stored as JSON text.
 */
function parseSeatIds(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") return JSON.parse(raw);
  return [];
}

// ─── SSE Stream ───────────────────────────────────────────────────────────────

router.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Send initial connection event
  res.write(`event: connected\ndata: {}\n\n`);

  // Keep-alive
  const keepAlive = setInterval(() => {
    res.write(`:keepalive\n\n`);
  }, 15000);

  addClient(res);

  req.on("close", () => {
    clearInterval(keepAlive);
  });
});

// ─── GET /seats ───────────────────────────────────────────────────────────────

router.get("/seats", async (req, res) => {
  try {
    // Lazy expiry: expire stale holds before reading
    await expireStaleHolds();

    const db = await getDb();
    const result = await db.query(`
      SELECT id, row_label, seat_number, status,
             hold_id, hold_session_id, hold_expires_at, booked_by
      FROM seats
      ORDER BY row_label, seat_number
    `);

    // Map effective status: if a seat is held but expired
    // (shouldn't happen after expiry sweep, but be safe)
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
          hold_session_id: null,
          hold_expires_at: null,
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

  // Deduplicate and validate seat IDs
  const uniqueSeatIds = [...new Set(seatIds.map((id) => parseInt(id, 10)))];
  if (uniqueSeatIds.some((id) => isNaN(id))) {
    return res
      .status(400)
      .json({ error: "All seatIds must be valid integers" });
  }

  try {
    // Expire stale holds first
    await expireStaleHolds();

    const db = await getDb();
    const holdId = uuidv4();
    const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

    const result = await db.transaction(async (tx) => {
      // Build placeholders for the IN clause
      const placeholders = uniqueSeatIds
        .map((_, i) => `$${i + 1}`)
        .join(", ");

      // Lock and check all requested seats atomically
      const seatsResult = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
         FROM seats
         WHERE id IN (${placeholders})
         FOR UPDATE`,
        uniqueSeatIds
      );

      // Check if we found all requested seats
      if (seatsResult.rows.length !== uniqueSeatIds.length) {
        const foundIds = new Set(seatsResult.rows.map((s) => s.id));
        const notFound = uniqueSeatIds.filter((id) => !foundIds.has(id));
        return { error: "notFound", seatIds: notFound };
      }

      // Check availability for each seat (also handle lazy expiry within tx)
      const unavailable = [];
      for (const seat of seatsResult.rows) {
        let effectiveStatus = seat.status;
        if (
          seat.status === "held" &&
          seat.hold_expires_at &&
          new Date(seat.hold_expires_at) <= new Date()
        ) {
          effectiveStatus = "available";
        }
        if (effectiveStatus !== "available") {
          unavailable.push(seat.id);
        }
      }

      if (unavailable.length > 0) {
        return { error: "conflict", seatIds: unavailable };
      }

      // All seats are available (or have expired holds). Acquire them all.
      // First, expire any stale holds on these seats within the transaction
      const staleHoldIds = seatsResult.rows
        .filter(
          (s) =>
            s.hold_id &&
            s.status === "held" &&
            s.hold_expires_at &&
            new Date(s.hold_expires_at) <= new Date()
        )
        .map((s) => s.hold_id);

      if (staleHoldIds.length > 0) {
        const staleHoldPlaceholders = staleHoldIds
          .map((_, i) => `$${i + 1}`)
          .join(", ");
        await tx.query(
          `UPDATE holds SET status = 'expired'
           WHERE id IN (${staleHoldPlaceholders}) AND status = 'active'`,
          staleHoldIds
        );
      }

      // Update all the seats to held
      const updatePlaceholders = uniqueSeatIds
        .map((_, i) => `$${i + 4}`)
        .join(", ");

      await tx.query(
        `UPDATE seats
         SET status = 'held',
             hold_id = $1,
             hold_session_id = $2,
             hold_expires_at = $3
         WHERE id IN (${updatePlaceholders})`,
        [holdId, sessionId, expiresAt.toISOString(), ...uniqueSeatIds]
      );

      // Create the hold record (seat_ids stored as JSON text)
      await tx.query(
        `INSERT INTO holds (id, session_id, seat_ids, expires_at, status)
         VALUES ($1, $2, $3, $4, 'active')`,
        [holdId, sessionId, JSON.stringify(uniqueSeatIds), expiresAt.toISOString()]
      );

      // Get the updated seats for response
      const updatedSeats = await tx.query(
        `SELECT id, row_label, seat_number, status,
                hold_id, hold_session_id, hold_expires_at, booked_by
         FROM seats
         WHERE id IN (${placeholders})`,
        uniqueSeatIds
      );

      return { success: true, seats: updatedSeats.rows };
    });

    if (result.error === "conflict") {
      return res.status(409).json({
        error: "Some seats are not available",
        conflictingSeatIds: result.seatIds,
      });
    }

    if (result.error === "notFound") {
      return res.status(400).json({
        error: "Some seat IDs do not exist",
        missingSeatIds: result.seatIds,
      });
    }

    // Broadcast seat updates
    for (const seat of result.seats) {
      broadcast("seatUpdate", seat);
    }

    res.status(201).json({
      holdId,
      sessionId,
      seatIds: uniqueSeatIds,
      expiresAt: expiresAt.toISOString(),
      seats: result.seats,
    });
  } catch (err) {
    console.error("POST /holds error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /holds/:holdId/confirm ─────────────────────────────────────────────

router.post("/holds/:holdId/confirm", async (req, res) => {
  const { holdId } = req.params;

  try {
    // Expire stale holds first
    await expireStaleHolds();

    const db = await getDb();

    const result = await db.transaction(async (tx) => {
      // Lock the hold record
      const holdResult = await tx.query(
        `SELECT id, session_id, seat_ids, expires_at, status, confirmed_at
         FROM holds
         WHERE id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        return { error: "notFound" };
      }

      const hold = holdResult.rows[0];
      const seatIds = parseSeatIds(hold.seat_ids);

      // Idempotent: if already confirmed, return success with the booking info
      if (hold.status === "confirmed") {
        const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
        const bookedSeats = await tx.query(
          `SELECT id, row_label, seat_number, status,
                  hold_id, hold_session_id, hold_expires_at, booked_by
           FROM seats
           WHERE id IN (${placeholders})`,
          seatIds
        );
        return {
          success: true,
          idempotent: true,
          seats: bookedSeats.rows,
          hold,
          seatIds,
        };
      }

      // Check if hold is expired or released
      if (hold.status === "expired" || hold.status === "released") {
        return {
          error: "expired",
          message:
            hold.status === "released"
              ? "Hold was released"
              : "Hold has expired",
        };
      }

      // Check if hold TTL has passed (server-side enforcement)
      if (new Date(hold.expires_at) <= new Date()) {
        // Mark hold as expired
        await tx.query(
          `UPDATE holds SET status = 'expired' WHERE id = $1`,
          [holdId]
        );
        // Release the seats
        const placeholders = seatIds.map((_, i) => `$${i + 2}`).join(", ");
        const releasedSeats = await tx.query(
          `UPDATE seats
           SET status = 'available',
               hold_id = NULL,
               hold_session_id = NULL,
               hold_expires_at = NULL
           WHERE hold_id = $1 AND id IN (${placeholders})
           RETURNING id, row_label, seat_number`,
          [holdId, ...seatIds]
        );
        return {
          error: "expired",
          message: "Hold has expired",
          releasedSeats: releasedSeats.rows,
        };
      }

      // Verify the seats are still held by this hold
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
      const seatsResult = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id
         FROM seats
         WHERE id IN (${placeholders})
         FOR UPDATE`,
        seatIds
      );

      // Verify every seat is held by this hold
      const notHeld = [];
      for (const seat of seatsResult.rows) {
        if (seat.status !== "held" || seat.hold_id !== holdId) {
          notHeld.push(seat.id);
        }
      }

      if (notHeld.length > 0) {
        // Hold is invalid — seats were released/taken
        await tx.query(
          `UPDATE holds SET status = 'expired' WHERE id = $1`,
          [holdId]
        );
        return {
          error: "expired",
          message: "Hold seats are no longer valid",
        };
      }

      // All good — book the seats
      const updatePlaceholders = seatIds
        .map((_, i) => `$${i + 3}`)
        .join(", ");

      await tx.query(
        `UPDATE seats
         SET status = 'booked',
             booked_by = $1,
             hold_expires_at = NULL
         WHERE hold_id = $2 AND id IN (${updatePlaceholders})`,
        [hold.session_id, holdId, ...seatIds]
      );

      // Mark hold as confirmed
      await tx.query(
        `UPDATE holds SET status = 'confirmed', confirmed_at = NOW()
         WHERE id = $1`,
        [holdId]
      );

      // Get updated seats
      const updatedSeats = await tx.query(
        `SELECT id, row_label, seat_number, status,
                hold_id, hold_session_id, hold_expires_at, booked_by
         FROM seats
         WHERE id IN (${placeholders})`,
        seatIds
      );

      return { success: true, seats: updatedSeats.rows, hold, seatIds };
    });

    if (result.error === "notFound") {
      return res.status(404).json({ error: "Hold not found" });
    }

    if (result.error === "expired") {
      // If we released seats, broadcast that
      if (result.releasedSeats) {
        for (const seat of result.releasedSeats) {
          broadcast("seatUpdate", {
            id: seat.id,
            row_label: seat.row_label,
            seat_number: seat.seat_number,
            status: "available",
            hold_id: null,
            hold_session_id: null,
            hold_expires_at: null,
            booked_by: null,
          });
        }
      }
      return res.status(410).json({ error: result.message });
    }

    // Broadcast seat updates (only if not idempotent repeat)
    if (!result.idempotent) {
      for (const seat of result.seats) {
        broadcast("seatUpdate", seat);
      }
    }

    res.json({
      holdId,
      sessionId: result.hold.session_id,
      status: "confirmed",
      seats: result.seats,
    });
  } catch (err) {
    console.error("POST /holds/:holdId/confirm error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── DELETE /holds/:holdId ────────────────────────────────────────────────────

router.delete("/holds/:holdId", async (req, res) => {
  const { holdId } = req.params;

  try {
    const db = await getDb();

    const result = await db.transaction(async (tx) => {
      // Lock the hold
      const holdResult = await tx.query(
        `SELECT id, session_id, seat_ids, status
         FROM holds
         WHERE id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        return { error: "notFound" };
      }

      const hold = holdResult.rows[0];
      const seatIds = parseSeatIds(hold.seat_ids);

      // Can only release active holds
      if (hold.status !== "active") {
        return {
          error: "invalid",
          message: `Cannot release a hold with status '${hold.status}'`,
        };
      }

      const placeholders = seatIds.map((_, i) => `$${i + 2}`).join(", ");

      // Release the seats
      await tx.query(
        `UPDATE seats
         SET status = 'available',
             hold_id = NULL,
             hold_session_id = NULL,
             hold_expires_at = NULL
         WHERE hold_id = $1 AND id IN (${placeholders})`,
        [holdId, ...seatIds]
      );

      // Mark hold as released
      await tx.query(
        `UPDATE holds SET status = 'released' WHERE id = $1`,
        [holdId]
      );

      // Get updated seats
      const seatPlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
      const updatedSeats = await tx.query(
        `SELECT id, row_label, seat_number, status,
                hold_id, hold_session_id, hold_expires_at, booked_by
         FROM seats
         WHERE id IN (${seatPlaceholders})`,
        seatIds
      );

      return { success: true, seats: updatedSeats.rows };
    });

    if (result.error === "notFound") {
      return res.status(404).json({ error: "Hold not found" });
    }

    if (result.error === "invalid") {
      return res.status(400).json({ error: result.message });
    }

    // Broadcast seat updates
    for (const seat of result.seats) {
      broadcast("seatUpdate", seat);
    }

    res.json({ holdId, status: "released", seats: result.seats });
  } catch (err) {
    console.error("DELETE /holds/:holdId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /inventory ───────────────────────────────────────────────────────────

router.get("/inventory", async (req, res) => {
  try {
    await expireStaleHolds();

    const db = await getDb();
    const result = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'available') as available,
        COUNT(*) FILTER (WHERE status = 'held') as held,
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
