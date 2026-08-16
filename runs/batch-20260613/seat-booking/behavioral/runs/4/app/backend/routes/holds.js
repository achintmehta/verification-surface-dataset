import { Router } from "express";
import { randomUUID } from "crypto";
import { getDb } from "../db.js";
import { expireHolds } from "../expiry.js";
import { broadcast } from "../sse.js";

const router = Router();

const HOLD_TTL_SECONDS = 60; // 1 minute

// ---------------------------------------------------------------------------
// POST /api/holds
// Body: { seatIds: string[], sessionId: string }
// ---------------------------------------------------------------------------
router.post("/", async (req, res) => {
  const { seatIds, sessionId } = req.body ?? {};

  if (
    !Array.isArray(seatIds) ||
    seatIds.length === 0 ||
    typeof sessionId !== "string" ||
    sessionId.trim() === ""
  ) {
    return res
      .status(400)
      .json({ error: "seatIds (non-empty array) and sessionId (string) are required" });
  }

  const uniqueSeatIds = [...new Set(seatIds)];

  try {
    const db = await getDb();

    // Expire stale holds first so we don't block on them
    await expireHolds(db);

    // --- Atomic check-and-set inside a transaction ---
    // PGLite is single-writer; we still use a transaction for atomicity.
    await db.exec("BEGIN");

    try {
      // Lock the requested rows (SELECT FOR UPDATE not supported in PGLite,
      // so we rely on PGLite's single-writer serialisation + transaction).
      const idList = uniqueSeatIds.map((id) => `'${id}'`).join(",");

      const { rows: seatRows } = await db.query(`
        SELECT id, status, hold_id, hold_expires_at
        FROM   seats
        WHERE  id IN (${idList})
      `);

      // Verify all requested seats exist
      if (seatRows.length !== uniqueSeatIds.length) {
        await db.exec("ROLLBACK");
        const found = new Set(seatRows.map((r) => r.id));
        const missing = uniqueSeatIds.filter((id) => !found.has(id));
        return res.status(404).json({ error: "Unknown seat ids", missing });
      }

      // Find unavailable seats (held with a valid hold, or booked)
      const unavailable = seatRows.filter((r) => {
        if (r.status === "booked") return true;
        if (r.status === "held") {
          // If the hold is expired it's effectively available
          if (r.hold_expires_at && new Date(r.hold_expires_at) <= new Date()) {
            return false;
          }
          return true;
        }
        return false;
      });

      if (unavailable.length > 0) {
        await db.exec("ROLLBACK");
        return res.status(409).json({
          error: "One or more seats are unavailable",
          conflicting: unavailable.map((r) => r.id),
        });
      }

      // Create the hold record
      const holdId = randomUUID();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

      await db.query(
        `INSERT INTO holds (id, session_id, expires_at, confirmed)
         VALUES ($1, $2, $3, FALSE)`,
        [holdId, sessionId.trim(), expiresAt.toISOString()]
      );

      // Mark seats as held
      await db.exec(`
        UPDATE seats
        SET    status          = 'held',
               hold_id         = '${holdId}',
               hold_expires_at = '${expiresAt.toISOString()}'
        WHERE  id IN (${idList})
      `);

      await db.exec("COMMIT");

      // Broadcast the state change
      const heldSeats = uniqueSeatIds.map((id) => ({
        id,
        status: "held",
        hold_id: holdId,
        hold_expires_at: expiresAt.toISOString(),
      }));

      broadcast("seat-update", { type: "held", seats: heldSeats });

      return res.status(201).json({
        hold: {
          id: holdId,
          session_id: sessionId.trim(),
          seat_ids: uniqueSeatIds,
          expires_at: expiresAt.toISOString(),
        },
      });
    } catch (innerErr) {
      await db.exec("ROLLBACK");
      throw innerErr;
    }
  } catch (err) {
    console.error("[POST /api/holds]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/holds/:holdId/confirm
// Idempotent: confirming an already-confirmed hold returns the same booking.
// ---------------------------------------------------------------------------
router.post("/:holdId/confirm", async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body ?? {};

  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    return res.status(400).json({ error: "sessionId is required" });
  }

  try {
    const db = await getDb();

    await db.exec("BEGIN");

    try {
      // Fetch the hold
      const { rows: holdRows } = await db.query(
        `SELECT id, session_id, expires_at, confirmed
         FROM   holds
         WHERE  id = $1`,
        [holdId]
      );

      if (holdRows.length === 0) {
        await db.exec("ROLLBACK");
        return res.status(404).json({ error: "Hold not found" });
      }

      const hold = holdRows[0];

      // Ownership check
      if (hold.session_id !== sessionId.trim()) {
        await db.exec("ROLLBACK");
        return res.status(403).json({ error: "Hold belongs to a different session" });
      }

      // Idempotency: already confirmed
      if (hold.confirmed) {
        const { rows: bookedSeats } = await db.query(
          `SELECT id, row_label, seat_number, status, booked_by
           FROM   seats
           WHERE  booked_by = $1`,
          [holdId]
        );
        await db.exec("ROLLBACK");
        return res.status(200).json({
          message: "Already confirmed",
          booking: {
            hold_id: holdId,
            session_id: hold.session_id,
            seats: bookedSeats,
          },
        });
      }

      // Expiry check
      if (new Date(hold.expires_at) <= new Date()) {
        await db.exec("ROLLBACK");
        return res.status(410).json({ error: "Hold has expired" });
      }

      // Verify the seats still belong to this hold
      const { rows: heldSeats } = await db.query(
        `SELECT id, row_label, seat_number
         FROM   seats
         WHERE  hold_id = $1 AND status = 'held'`,
        [holdId]
      );

      if (heldSeats.length === 0) {
        await db.exec("ROLLBACK");
        return res.status(409).json({ error: "No held seats found for this hold" });
      }

      // Book the seats
      await db.query(
        `UPDATE seats
         SET    status          = 'booked',
                hold_id         = NULL,
                hold_expires_at = NULL,
                booked_by       = $1
         WHERE  hold_id = $2 AND status = 'held'`,
        [holdId, holdId]
      );

      // Mark hold as confirmed
      await db.query(
        `UPDATE holds SET confirmed = TRUE WHERE id = $1`,
        [holdId]
      );

      await db.exec("COMMIT");

      // Broadcast
      broadcast("seat-update", {
        type: "booked",
        seats: heldSeats.map((s) => ({
          id: s.id,
          status: "booked",
          booked_by: holdId,
        })),
      });

      return res.status(200).json({
        booking: {
          hold_id: holdId,
          session_id: hold.session_id,
          seats: heldSeats,
        },
      });
    } catch (innerErr) {
      await db.exec("ROLLBACK");
      throw innerErr;
    }
  } catch (err) {
    console.error("[POST /api/holds/:holdId/confirm]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/holds/:holdId
// Release a hold early, returning its seats to available.
// ---------------------------------------------------------------------------
router.delete("/:holdId", async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body ?? {};

  try {
    const db = await getDb();

    await db.exec("BEGIN");

    try {
      const { rows: holdRows } = await db.query(
        `SELECT id, session_id, confirmed FROM holds WHERE id = $1`,
        [holdId]
      );

      if (holdRows.length === 0) {
        await db.exec("ROLLBACK");
        return res.status(404).json({ error: "Hold not found" });
      }

      const hold = holdRows[0];

      if (sessionId && hold.session_id !== sessionId.trim()) {
        await db.exec("ROLLBACK");
        return res.status(403).json({ error: "Hold belongs to a different session" });
      }

      if (hold.confirmed) {
        await db.exec("ROLLBACK");
        return res.status(409).json({ error: "Cannot release a confirmed hold" });
      }

      // Release seats
      const { rows: releasedSeats } = await db.query(
        `UPDATE seats
         SET    status = 'available',
                hold_id = NULL,
                hold_expires_at = NULL
         WHERE  hold_id = $1 AND status = 'held'
         RETURNING id, row_label, seat_number`,
        [holdId]
      );

      // Delete the hold record
      await db.query(`DELETE FROM holds WHERE id = $1`, [holdId]);

      await db.exec("COMMIT");

      broadcast("seat-update", {
        type: "released",
        seats: releasedSeats.map((s) => ({
          id: s.id,
          status: "available",
        })),
      });

      return res.status(200).json({
        released: releasedSeats.map((s) => s.id),
      });
    } catch (innerErr) {
      await db.exec("ROLLBACK");
      throw innerErr;
    }
  } catch (err) {
    console.error("[DELETE /api/holds/:holdId]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export { HOLD_TTL_SECONDS };
export default router;
