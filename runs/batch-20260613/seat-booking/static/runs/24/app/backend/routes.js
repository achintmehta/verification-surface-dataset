import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { sweepExpiredHolds, getEffectiveStatus } from "./expiry.js";
import { addClient, removeClient, broadcastSeatUpdate } from "./sse.js";

// Hold TTL in seconds
const HOLD_TTL_SECONDS = 60;

/**
 * Create the Express router with all API endpoints.
 * @param {import("@electric-sql/pglite").PGlite} db
 * @returns {import("express").Router}
 */
export function createRouter(db) {
  const router = Router();

  // ── GET /api/seats ─────────────────────────────────────────────────
  // Return all seats with effective status (expired holds → available)
  router.get("/api/seats", async (_req, res) => {
    try {
      // Sweep expired holds first (lazy expiry on read)
      await sweepExpiredHolds(db);

      const result = await db.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
         FROM seats
         ORDER BY row_label, seat_number`
      );

      const seats = result.rows.map(getEffectiveStatus);
      res.json({ seats });
    } catch (err) {
      console.error("Error fetching seats:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── POST /api/holds ────────────────────────────────────────────────
  // Atomically hold all requested seats or fail with 409
  router.post("/api/holds", async (req, res) => {
    try {
      const { seatIds, sessionId } = req.body;

      if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
        res.status(400).json({ error: "seatIds must be a non-empty array" });
        return;
      }

      if (!sessionId || typeof sessionId !== "string") {
        res.status(400).json({ error: "sessionId is required" });
        return;
      }

      // Deduplicate seat IDs
      const uniqueSeatIds = [...new Set(seatIds)];

      const holdId = uuidv4();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

      // Use a transaction for atomicity.
      const result = await db.transaction(async (tx) => {
        // First, sweep expired holds within the transaction
        await tx.query(
          `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL
           WHERE status = 'held'
             AND hold_expires_at IS NOT NULL
             AND hold_expires_at <= NOW()`
        );

        // Mark corresponding holds as expired
        await tx.query(
          `UPDATE holds
           SET status = 'expired'
           WHERE status = 'active'
             AND expires_at <= NOW()`
        );

        // Check all requested seats are available (FOR UPDATE locks the rows)
        const seatCheck = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
           FROM seats
           WHERE id = ANY($1::int[])
           FOR UPDATE`,
          [uniqueSeatIds]
        );

        // Verify all requested seats exist
        if (seatCheck.rows.length !== uniqueSeatIds.length) {
          const foundIds = new Set(seatCheck.rows.map((s) => s.id));
          const missingIds = uniqueSeatIds.filter((id) => !foundIds.has(id));
          return { success: false, error: "Some seats do not exist", missingIds };
        }

        // Check for unavailable seats
        const unavailableSeats = seatCheck.rows.filter(
          (s) => s.status !== "available"
        );

        if (unavailableSeats.length > 0) {
          const conflictingSeatIds = unavailableSeats.map((s) => s.id);
          return { success: false, conflict: true, conflictingSeatIds };
        }

        // All seats available — acquire the hold
        await tx.query(
          `UPDATE seats
           SET status = 'held', hold_id = $1, hold_expires_at = $2
           WHERE id = ANY($3::int[])`,
          [holdId, expiresAt.toISOString(), uniqueSeatIds]
        );

        // Create the hold record
        await tx.query(
          `INSERT INTO holds (id, session_id, seat_ids, expires_at, status)
           VALUES ($1, $2, $3, $4, 'active')`,
          [holdId, sessionId, uniqueSeatIds, expiresAt.toISOString()]
        );

        // Fetch updated seats
        const updatedSeats = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
           FROM seats
           WHERE id = ANY($1::int[])`,
          [uniqueSeatIds]
        );

        return { success: true, seats: updatedSeats.rows };
      });

      if (!result.success) {
        if (result.conflict) {
          res.status(409).json({
            error: "Some seats are not available",
            conflictingSeatIds: result.conflictingSeatIds,
          });
          return;
        }
        res.status(400).json({
          error: result.error || "Failed to acquire hold",
          missingSeatIds: result.missingIds,
        });
        return;
      }

      // Map to effective seats for broadcast
      const effectiveSeats = result.seats.map((s) => ({
        id: s.id,
        row_label: s.row_label,
        seat_number: s.seat_number,
        status: s.status,
        hold_id: s.hold_id,
        hold_expires_at: s.hold_expires_at,
      }));

      // Broadcast the hold
      broadcastSeatUpdate(effectiveSeats);

      res.status(201).json({
        holdId,
        seats: effectiveSeats,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (err) {
      console.error("Error creating hold:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── POST /api/holds/:holdId/confirm ────────────────────────────────
  // Confirm an active hold, booking the seats permanently
  router.post("/api/holds/:holdId/confirm", async (req, res) => {
    try {
      const { holdId } = req.params;

      const result = await db.transaction(async (tx) => {
        // First, sweep expired holds within the transaction
        await tx.query(
          `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL
           WHERE status = 'held'
             AND hold_expires_at IS NOT NULL
             AND hold_expires_at <= NOW()`
        );

        await tx.query(
          `UPDATE holds
           SET status = 'expired'
           WHERE status = 'active'
             AND expires_at <= NOW()`
        );

        // Find the hold (FOR UPDATE locks the row)
        const holdResult = await tx.query(
          `SELECT id, session_id, seat_ids, expires_at, status, created_at, confirmed_at
           FROM holds
           WHERE id = $1
           FOR UPDATE`,
          [holdId]
        );

        if (holdResult.rows.length === 0) {
          return { success: false, error: "Hold not found", statusCode: 404 };
        }

        const hold = holdResult.rows[0];

        // Idempotent: if already confirmed, return the same booking
        if (hold.status === "confirmed") {
          const bookedSeats = await tx.query(
            `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
             FROM seats
             WHERE id = ANY($1::int[])`,
            [hold.seat_ids]
          );

          return {
            success: true,
            idempotent: true,
            hold,
            seats: bookedSeats.rows,
          };
        }

        // Check if hold is expired or released
        if (hold.status === "expired" || hold.status === "released") {
          return {
            success: false,
            error: `Hold has been ${hold.status}`,
            statusCode: 410,
          };
        }

        // Double-check: is the hold expired by time?
        if (new Date(hold.expires_at) <= new Date()) {
          // Release the seats for safety
          await tx.query(
            `UPDATE seats
             SET status = 'available', hold_id = NULL, hold_expires_at = NULL
             WHERE hold_id = $1 AND status = 'held'`,
            [holdId]
          );

          await tx.query(
            `UPDATE holds SET status = 'expired' WHERE id = $1`,
            [holdId]
          );

          return {
            success: false,
            error: "Hold has expired",
            statusCode: 410,
          };
        }

        // Verify the seats are still held by this hold
        const seatsCheck = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
           FROM seats
           WHERE id = ANY($1::int[])
           FOR UPDATE`,
          [hold.seat_ids]
        );

        const notOwned = seatsCheck.rows.filter(
          (s) => s.status !== "held" || s.hold_id !== holdId
        );

        if (notOwned.length > 0) {
          return {
            success: false,
            error: "Hold is no longer valid for some seats",
            statusCode: 409,
          };
        }

        const confirmedAt = new Date().toISOString();

        // Book the seats
        await tx.query(
          `UPDATE seats
           SET status = 'booked', booked_by = $1, hold_id = NULL, hold_expires_at = NULL
           WHERE id = ANY($2::int[])
             AND hold_id = $3`,
          [hold.session_id, hold.seat_ids, holdId]
        );

        // Mark hold as confirmed
        await tx.query(
          `UPDATE holds
           SET status = 'confirmed', confirmed_at = $1
           WHERE id = $2`,
          [confirmedAt, holdId]
        );

        // Fetch updated seats
        const updatedSeats = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
           FROM seats
           WHERE id = ANY($1::int[])`,
          [hold.seat_ids]
        );

        return {
          success: true,
          idempotent: false,
          hold: { ...hold, status: "confirmed", confirmed_at: confirmedAt },
          seats: updatedSeats.rows,
        };
      });

      if (!result.success) {
        res.status(result.statusCode || 500).json({ error: result.error });
        return;
      }

      const effectiveSeats = result.seats.map((s) => ({
        id: s.id,
        row_label: s.row_label,
        seat_number: s.seat_number,
        status: s.status,
        hold_id: s.hold_id,
        hold_expires_at: s.hold_expires_at,
      }));

      // Only broadcast if not idempotent (first confirm)
      if (!result.idempotent) {
        broadcastSeatUpdate(effectiveSeats);
      }

      res.json({
        holdId: result.hold.id,
        seats: effectiveSeats,
        confirmedAt: result.hold.confirmed_at,
      });
    } catch (err) {
      console.error("Error confirming hold:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── DELETE /api/holds/:holdId ──────────────────────────────────────
  // Release a hold early
  router.delete("/api/holds/:holdId", async (req, res) => {
    try {
      const { holdId } = req.params;

      const result = await db.transaction(async (tx) => {
        // Find the hold
        const holdResult = await tx.query(
          `SELECT id, session_id, seat_ids, expires_at, status, created_at, confirmed_at
           FROM holds
           WHERE id = $1
           FOR UPDATE`,
          [holdId]
        );

        if (holdResult.rows.length === 0) {
          return { success: false, error: "Hold not found", statusCode: 404 };
        }

        const hold = holdResult.rows[0];

        if (hold.status === "confirmed") {
          return {
            success: false,
            error: "Cannot release a confirmed hold",
            statusCode: 400,
          };
        }

        if (hold.status === "released" || hold.status === "expired") {
          // Idempotent: already released
          return { success: true, alreadyReleased: true, hold };
        }

        // Release the seats
        await tx.query(
          `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL
           WHERE hold_id = $1 AND status = 'held'`,
          [holdId]
        );

        // Mark hold as released
        await tx.query(
          `UPDATE holds SET status = 'released' WHERE id = $1`,
          [holdId]
        );

        // Fetch released seats
        const releasedSeats = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
           FROM seats
           WHERE id = ANY($1::int[])`,
          [hold.seat_ids]
        );

        return {
          success: true,
          alreadyReleased: false,
          seats: releasedSeats.rows,
          hold,
        };
      });

      if (!result.success) {
        res.status(result.statusCode || 500).json({ error: result.error });
        return;
      }

      if (!result.alreadyReleased && result.seats) {
        const effectiveSeats = result.seats.map((s) => ({
          id: s.id,
          row_label: s.row_label,
          seat_number: s.seat_number,
          status: s.status,
          hold_id: s.hold_id,
          hold_expires_at: s.hold_expires_at,
        }));

        broadcastSeatUpdate(effectiveSeats);
      }

      res.json({ message: "Hold released" });
    } catch (err) {
      console.error("Error releasing hold:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── GET /api/stream ────────────────────────────────────────────────
  // SSE endpoint for real-time seat updates
  router.get("/api/stream", (_req, res) => {
    // Set SSE headers
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    // Send initial connection event
    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

    // Add client to the set
    addClient(res);

    // Keep-alive heartbeat
    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 15000);

    // Handle client disconnect
    _req.on("close", () => {
      clearInterval(heartbeat);
      removeClient(res);
    });
  });

  // ── GET /api/inventory ─────────────────────────────────────────────
  // Return counts of available, held, and booked seats
  router.get("/api/inventory", async (_req, res) => {
    try {
      // Sweep expired holds first
      await sweepExpiredHolds(db);

      const result = await db.query(
        `SELECT status, COUNT(*) as count
         FROM seats
         GROUP BY status`
      );

      const inventory = {
        available: 0,
        held: 0,
        booked: 0,
      };

      for (const row of result.rows) {
        inventory[row.status] = parseInt(row.count, 10);
      }

      const total = inventory.available + inventory.held + inventory.booked;

      res.json({ ...inventory, total });
    } catch (err) {
      console.error("Error fetching inventory:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
