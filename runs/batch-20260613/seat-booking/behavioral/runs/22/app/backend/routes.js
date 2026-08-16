const express = require("express");
const crypto = require("crypto");
const { getDb } = require("./db");
const { addClient, broadcast } = require("./sse");
const { expireStaleHolds, expireAndBroadcast } = require("./expiry");

const router = express.Router();

const HOLD_TTL_SECONDS = parseInt(process.env.HOLD_TTL_SECONDS || "60", 10);

// ---------------------------------------------------------------------------
// SSE stream
// ---------------------------------------------------------------------------
router.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(":\n\n"); // comment to keep connection
  addClient(res);
});

// ---------------------------------------------------------------------------
// GET /seats — returns all seats with effective status
// ---------------------------------------------------------------------------
router.get("/seats", async (req, res) => {
  try {
    const db = await getDb();
    // Expire stale holds first
    await expireAndBroadcast(db);

    const result = await db.query(`
      SELECT id, row_label, seat_number, status, hold_id, hold_session_id,
             hold_expires_at, booked_by
      FROM seats
      ORDER BY row_label, seat_number
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("GET /seats error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /holds — atomic all-or-nothing hold acquisition
// ---------------------------------------------------------------------------
router.post("/holds", async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (!Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: "seatIds (non-empty array) and sessionId are required" });
  }

  // Ensure seatIds are integers
  const ids = seatIds.map((id) => parseInt(id, 10));
  if (ids.some((id) => isNaN(id))) {
    return res.status(400).json({ error: "seatIds must be integers" });
  }

  const holdId = crypto.randomUUID();

  try {
    const db = await getDb();

    // Use a transaction for atomicity
    const result = await db.transaction(async (tx) => {
      // 1. Expire stale holds inside the transaction
      await expireStaleHolds(tx);

      // 2. Lock and check all requested seats
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
      const seatsResult = await tx.query(
        `SELECT id, status FROM seats WHERE id IN (${placeholders}) FOR UPDATE`,
        ids
      );

      if (seatsResult.rows.length !== ids.length) {
        const foundIds = new Set(seatsResult.rows.map((r) => r.id));
        const notFound = ids.filter((id) => !foundIds.has(id));
        return { error: true, status: 400, body: { error: "Some seat ids not found", seatIds: notFound } };
      }

      const conflicting = seatsResult.rows.filter((r) => r.status !== "available");
      if (conflicting.length > 0) {
        return {
          error: true,
          status: 409,
          body: {
            error: "Some seats are not available",
            conflictingSeatIds: conflicting.map((r) => r.id),
          },
        };
      }

      // 3. Mark seats as held
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();
      const updatePlaceholders = ids.map((_, i) => `$${i + 4}`).join(", ");
      await tx.query(
        `UPDATE seats
         SET status = 'held',
             hold_id = $1,
             hold_session_id = $2,
             hold_expires_at = $3::timestamptz
         WHERE id IN (${updatePlaceholders})`,
        [holdId, sessionId, expiresAt, ...ids]
      );

      // 4. Create hold record
      await tx.query(
        `INSERT INTO holds (id, session_id, seat_ids, expires_at)
         VALUES ($1, $2, $3, $4::timestamptz)`,
        [holdId, sessionId, ids, expiresAt]
      );

      return {
        error: false,
        hold: {
          holdId,
          sessionId,
          seatIds: ids,
          expiresAt,
        },
      };
    });

    if (result.error) {
      return res.status(result.status).json(result.body);
    }

    // Broadcast the hold
    const updatedSeats = await db.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_session_id,
              hold_expires_at, booked_by
       FROM seats WHERE hold_id = $1`,
      [holdId]
    );
    broadcast("seats-updated", updatedSeats.rows);

    return res.status(201).json(result.hold);
  } catch (err) {
    console.error("POST /holds error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /holds/:holdId/confirm — idempotent confirmation
// ---------------------------------------------------------------------------
router.post("/holds/:holdId/confirm", async (req, res) => {
  const { holdId } = req.params;

  try {
    const db = await getDb();

    const result = await db.transaction(async (tx) => {
      // 1. Expire stale holds
      await expireStaleHolds(tx);

      // 2. Find the hold
      const holdResult = await tx.query(
        `SELECT id, session_id, seat_ids, expires_at, status
         FROM holds WHERE id = $1 FOR UPDATE`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        return { error: true, status: 404, body: { error: "Hold not found" } };
      }

      const hold = holdResult.rows[0];

      // Idempotent: if already confirmed, return success
      if (hold.status === "confirmed") {
        const seats = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_session_id,
                  hold_expires_at, booked_by
           FROM seats WHERE booked_by = $1 AND hold_id = $2`,
          [hold.session_id, holdId]
        );
        return {
          error: false,
          alreadyConfirmed: true,
          booking: {
            holdId: hold.id,
            sessionId: hold.session_id,
            seatIds: hold.seat_ids,
            status: "confirmed",
          },
          seats: seats.rows,
        };
      }

      // Check if hold expired or released
      if (hold.status === "expired" || hold.status === "released") {
        return { error: true, status: 410, body: { error: `Hold has ${hold.status}` } };
      }

      // Check expiry time
      if (new Date(hold.expires_at) < new Date()) {
        // Mark as expired
        await tx.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [holdId]);
        // Release seats
        await tx.query(
          `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_session_id = NULL, hold_expires_at = NULL
           WHERE hold_id = $1 AND status = 'held'`,
          [holdId]
        );
        return { error: true, status: 410, body: { error: "Hold has expired" } };
      }

      // 3. Verify all seats are still held by this hold
      const seatIds = hold.seat_ids;
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
      const seatCheck = await tx.query(
        `SELECT id, status, hold_id FROM seats
         WHERE id IN (${placeholders}) FOR UPDATE`,
        seatIds
      );

      const invalidSeats = seatCheck.rows.filter(
        (s) => s.status !== "held" || s.hold_id !== holdId
      );
      if (invalidSeats.length > 0) {
        // Hold is invalid — some seats no longer held by this hold
        await tx.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [holdId]);
        return {
          error: true,
          status: 409,
          body: { error: "Hold is no longer valid for all seats" },
        };
      }

      // 4. Book the seats
      const updatePlaceholders = seatIds.map((_, i) => `$${i + 3}`).join(", ");
      await tx.query(
        `UPDATE seats
         SET status = 'booked',
             booked_by = $1
         WHERE hold_id = $2 AND id IN (${updatePlaceholders})`,
        [hold.session_id, holdId, ...seatIds]
      );

      // 5. Mark hold as confirmed
      await tx.query(`UPDATE holds SET status = 'confirmed' WHERE id = $1`, [holdId]);

      const seats = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_session_id,
                hold_expires_at, booked_by
         FROM seats WHERE id IN (${placeholders})`,
        seatIds
      );

      return {
        error: false,
        alreadyConfirmed: false,
        booking: {
          holdId: hold.id,
          sessionId: hold.session_id,
          seatIds: hold.seat_ids,
          status: "confirmed",
        },
        seats: seats.rows,
      };
    });

    if (result.error) {
      return res.status(result.status).json(result.body);
    }

    // Broadcast booked seats (only if newly confirmed)
    if (!result.alreadyConfirmed) {
      broadcast("seats-updated", result.seats);
    }

    return res.json(result.booking);
  } catch (err) {
    console.error("POST /holds/:holdId/confirm error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /holds/:holdId — release a hold early
// ---------------------------------------------------------------------------
router.delete("/holds/:holdId", async (req, res) => {
  const { holdId } = req.params;

  try {
    const db = await getDb();

    const result = await db.transaction(async (tx) => {
      const holdResult = await tx.query(
        `SELECT id, session_id, seat_ids, status FROM holds WHERE id = $1 FOR UPDATE`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        return { error: true, status: 404, body: { error: "Hold not found" } };
      }

      const hold = holdResult.rows[0];

      if (hold.status === "confirmed") {
        return { error: true, status: 400, body: { error: "Cannot release a confirmed hold" } };
      }

      if (hold.status === "released") {
        // Idempotent — already released
        return { error: false, alreadyReleased: true, seats: [] };
      }

      // Release the seats
      const seatIds = hold.seat_ids;
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
      await tx.query(
        `UPDATE seats
         SET status = 'available',
             hold_id = NULL,
             hold_session_id = NULL,
             hold_expires_at = NULL
         WHERE hold_id = $${seatIds.length + 1} AND id IN (${placeholders})`,
        [...seatIds, holdId]
      );

      await tx.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);

      const seats = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_session_id,
                hold_expires_at, booked_by
         FROM seats WHERE id IN (${placeholders})`,
        seatIds
      );

      return { error: false, alreadyReleased: false, seats: seats.rows };
    });

    if (result.error) {
      return res.status(result.status).json(result.body);
    }

    if (!result.alreadyReleased && result.seats.length > 0) {
      broadcast("seats-updated", result.seats);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("DELETE /holds/:holdId error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /inventory — summary counts
// ---------------------------------------------------------------------------
router.get("/inventory", async (req, res) => {
  try {
    const db = await getDb();
    await expireAndBroadcast(db);

    const result = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'available') AS available,
        COUNT(*) FILTER (WHERE status = 'held') AS held,
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

module.exports = router;
