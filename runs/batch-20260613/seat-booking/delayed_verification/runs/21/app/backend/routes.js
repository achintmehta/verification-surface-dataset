const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { getDb } = require("./db");
const { addClient, broadcast } = require("./sse");
const { expireStaleHolds } = require("./expiry");

const router = express.Router();

const HOLD_TTL_SECONDS = parseInt(process.env.HOLD_TTL_SECONDS || "30", 10);

// ────────────────────────────────────────────
// SSE endpoint
// ────────────────────────────────────────────
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

// ────────────────────────────────────────────
// GET /api/seats – return all seats with effective status
// ────────────────────────────────────────────
router.get("/seats", async (req, res) => {
  try {
    // First expire stale holds
    await expireStaleHolds();

    const db = await getDb();
    const result = await db.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
       FROM seats
       ORDER BY row_label, seat_number`
    );

    // Compute effective status for any stragglers: held seats past expiry shown as available
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

    res.json({ seats, holdTtlSeconds: HOLD_TTL_SECONDS });
  } catch (err) {
    console.error("GET /seats error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ────────────────────────────────────────────
// POST /api/holds – atomically hold seats (all-or-nothing)
// ────────────────────────────────────────────
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
  if (uniqueSeatIds.some((id) => isNaN(id))) {
    return res.status(400).json({ error: "Invalid seat ids" });
  }

  // Sort seat IDs to prevent deadlocks when concurrent transactions lock rows
  uniqueSeatIds.sort((a, b) => a - b);

  try {
    const db = await getDb();

    // Expire stale holds first
    await expireStaleHolds();

    const holdId = uuidv4();
    const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

    const result = await db.transaction(async (tx) => {
      // Lock and check all requested seats using FOR UPDATE
      // Sorted order prevents deadlocks
      const placeholders = uniqueSeatIds
        .map((_, i) => `$${i + 1}`)
        .join(", ");
      const checkResult = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
         FROM seats
         WHERE id IN (${placeholders})
         ORDER BY id
         FOR UPDATE`,
        uniqueSeatIds
      );

      if (checkResult.rows.length !== uniqueSeatIds.length) {
        const foundIds = new Set(checkResult.rows.map((r) => r.id));
        const missingIds = uniqueSeatIds.filter((id) => !foundIds.has(id));
        return { error: "Some seat ids not found", missingIds, status: 400 };
      }

      // Check which seats are unavailable (considering expiry within the tx)
      const unavailable = [];
      for (const seat of checkResult.rows) {
        let effectiveStatus = seat.status;

        // If held but expired, release inline within this transaction
        if (
          seat.status === "held" &&
          seat.hold_expires_at &&
          new Date(seat.hold_expires_at) <= new Date()
        ) {
          effectiveStatus = "available";
          // Release this expired seat
          await tx.query(
            `UPDATE seats
             SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
             WHERE id = $1`,
            [seat.id]
          );
          // Mark the hold as expired
          if (seat.hold_id) {
            await tx.query(
              `UPDATE holds SET status = 'expired'
               WHERE id = $1 AND status = 'active'`,
              [seat.hold_id]
            );
          }
        }

        if (effectiveStatus !== "available") {
          unavailable.push({
            id: seat.id,
            row_label: seat.row_label,
            seat_number: seat.seat_number,
            status: effectiveStatus,
          });
        }
      }

      if (unavailable.length > 0) {
        return {
          error: "Some seats are unavailable",
          conflicting: unavailable,
          status: 409,
        };
      }

      // All seats available — mark them as held
      const updatePlaceholders = uniqueSeatIds
        .map((_, i) => `$${i + 4}`)
        .join(", ");
      await tx.query(
        `UPDATE seats
         SET status = 'held', hold_id = $1, hold_expires_at = $2, session_id = $3
         WHERE id IN (${updatePlaceholders})`,
        [holdId, expiresAt.toISOString(), sessionId, ...uniqueSeatIds]
      );

      // Create the hold record
      await tx.query(
        `INSERT INTO holds (id, session_id, seat_ids, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [holdId, sessionId, uniqueSeatIds, expiresAt.toISOString()]
      );

      // Fetch updated seats for response and broadcast
      const updatedSeats = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
         FROM seats WHERE hold_id = $1`,
        [holdId]
      );

      return { success: true, seats: updatedSeats.rows };
    });

    if (result.error) {
      return res.status(result.status).json({
        error: result.error,
        conflicting: result.conflicting,
        missingIds: result.missingIds,
      });
    }

    // Broadcast the hold
    broadcast("seats-updated", {
      seats: result.seats,
      reason: "held",
      holdId,
    });

    res.status(201).json({
      holdId,
      sessionId,
      seatIds: uniqueSeatIds,
      expiresAt: expiresAt.toISOString(),
      holdTtlSeconds: HOLD_TTL_SECONDS,
      seats: result.seats,
    });
  } catch (err) {
    console.error("POST /holds error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ────────────────────────────────────────────
// POST /api/holds/:holdId/confirm – confirm a hold (idempotent)
// ────────────────────────────────────────────
router.post("/holds/:holdId/confirm", async (req, res) => {
  const { holdId } = req.params;

  try {
    const db = await getDb();

    // Expire stale holds first (outside the main transaction)
    await expireStaleHolds();

    const result = await db.transaction(async (tx) => {
      // Lock the hold record
      const holdResult = await tx.query(
        `SELECT id, session_id, seat_ids, expires_at, status
         FROM holds
         WHERE id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        return { error: "Hold not found", status: 404 };
      }

      const hold = holdResult.rows[0];

      // Idempotent: if already confirmed, return the same result
      if (hold.status === "confirmed") {
        const bookedSeats = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
           FROM seats
           WHERE hold_id = $1`,
          [holdId]
        );
        return {
          success: true,
          idempotent: true,
          hold,
          seats: bookedSeats.rows,
        };
      }

      // Check if hold has expired
      if (
        hold.status === "expired" ||
        hold.status === "released" ||
        new Date(hold.expires_at) <= new Date()
      ) {
        // If still marked active but expired by time, clean up
        if (hold.status === "active") {
          await tx.query(
            `UPDATE holds SET status = 'expired' WHERE id = $1`,
            [holdId]
          );
          const releasedSeats = await tx.query(
            `UPDATE seats
             SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
             WHERE hold_id = $1 AND status = 'held'
             RETURNING id, row_label, seat_number`,
            [holdId]
          );
          return {
            error: "Hold has expired",
            status: 410,
            releasedSeats: releasedSeats.rows,
          };
        }
        const msg =
          hold.status === "released"
            ? "Hold was released"
            : "Hold has expired";
        return { error: msg, status: 410 };
      }

      if (hold.status !== "active") {
        return { error: "Hold is not active", status: 409 };
      }

      // Lock and verify all seats are still held by this hold
      const seatIds = hold.seat_ids;
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
      const seatCheck = await tx.query(
        `SELECT id, status, hold_id
         FROM seats
         WHERE id IN (${placeholders})
         ORDER BY id
         FOR UPDATE`,
        seatIds
      );

      for (const seat of seatCheck.rows) {
        if (seat.status !== "held" || seat.hold_id !== holdId) {
          return {
            error: "Seat state inconsistency – hold cannot be confirmed",
            status: 409,
          };
        }
      }

      // Book all seats
      const updatePlaceholders = seatIds
        .map((_, i) => `$${i + 3}`)
        .join(", ");
      await tx.query(
        `UPDATE seats
         SET status = 'booked', booked_by = $1, hold_expires_at = NULL
         WHERE hold_id = $2 AND id IN (${updatePlaceholders})`,
        [hold.session_id, holdId, ...seatIds]
      );

      // Mark hold as confirmed
      await tx.query(`UPDATE holds SET status = 'confirmed' WHERE id = $1`, [
        holdId,
      ]);

      // Fetch updated seats
      const bookedSeats = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
         FROM seats WHERE hold_id = $1`,
        [holdId]
      );

      return { success: true, hold, seats: bookedSeats.rows };
    });

    if (result.error) {
      // Broadcast releases if we expired holds during confirm
      if (result.releasedSeats && result.releasedSeats.length > 0) {
        broadcast("seats-updated", {
          seats: result.releasedSeats.map((s) => ({
            id: s.id,
            row_label: s.row_label,
            seat_number: s.seat_number,
            status: "available",
            hold_id: null,
            hold_expires_at: null,
            session_id: null,
            booked_by: null,
          })),
          reason: "expired",
        });
      }
      return res.status(result.status).json({ error: result.error });
    }

    // Broadcast booking
    if (!result.idempotent) {
      broadcast("seats-updated", {
        seats: result.seats,
        reason: "booked",
        holdId,
      });
    }

    res.json({
      holdId,
      sessionId: result.hold.session_id,
      status: "confirmed",
      seats: result.seats,
      idempotent: result.idempotent || false,
    });
  } catch (err) {
    console.error("POST /holds/:holdId/confirm error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ────────────────────────────────────────────
// DELETE /api/holds/:holdId – release a hold early
// ────────────────────────────────────────────
router.delete("/holds/:holdId", async (req, res) => {
  const { holdId } = req.params;

  try {
    const db = await getDb();

    const result = await db.transaction(async (tx) => {
      const holdResult = await tx.query(
        `SELECT id, session_id, seat_ids, status
         FROM holds WHERE id = $1 FOR UPDATE`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        return { error: "Hold not found", status: 404 };
      }

      const hold = holdResult.rows[0];

      if (hold.status === "confirmed") {
        return { error: "Hold already confirmed, cannot release", status: 409 };
      }

      if (hold.status === "released" || hold.status === "expired") {
        // Idempotent release
        return { success: true, alreadyReleased: true, seats: [] };
      }

      // Release the seats
      const released = await tx.query(
        `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
         WHERE hold_id = $1 AND status = 'held'
         RETURNING id, row_label, seat_number`,
        [holdId]
      );

      await tx.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [
        holdId,
      ]);

      return { success: true, seats: released.rows };
    });

    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }

    if (result.seats && result.seats.length > 0) {
      const releasedSeats = result.seats.map((s) => ({
        id: s.id,
        row_label: s.row_label,
        seat_number: s.seat_number,
        status: "available",
        hold_id: null,
        hold_expires_at: null,
        session_id: null,
        booked_by: null,
      }));

      broadcast("seats-updated", {
        seats: releasedSeats,
        reason: "released",
        holdId,
      });
    }

    res.json({ holdId, status: "released" });
  } catch (err) {
    console.error("DELETE /holds/:holdId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ────────────────────────────────────────────
// GET /api/inventory – inventory summary
// ────────────────────────────────────────────
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
    console.error("GET /inventory error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
