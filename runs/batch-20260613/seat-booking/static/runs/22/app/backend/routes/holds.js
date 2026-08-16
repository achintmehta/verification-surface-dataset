import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "../db.js";
import { expireStaleHolds } from "../expiry.js";
import { broadcast } from "../sse.js";

const router = Router();

/** Hold TTL in seconds */
const HOLD_TTL_SECONDS = 60;

/**
 * POST /api/holds
 * Body: { seatIds: number[], sessionId: string }
 *
 * Atomically acquires ALL requested seats only if every one is currently
 * available. All-or-nothing semantics.
 */
router.post("/", async (req, res) => {
  try {
    const { seatIds, sessionId } = req.body;

    // Input validation
    if (
      !Array.isArray(seatIds) ||
      seatIds.length === 0 ||
      !sessionId ||
      typeof sessionId !== "string"
    ) {
      return res
        .status(400)
        .json({
          error:
            "seatIds (non-empty array) and sessionId (string) are required",
        });
    }

    // Deduplicate seat ids
    const uniqueSeatIds = [...new Set(seatIds)];

    const db = await getDb();

    // Expire stale holds first
    await expireStaleHolds(db);

    const holdId = uuidv4();
    const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

    const result = await db.transaction(async (/** @type {any} */ tx) => {
      // Lock and check all requested seats
      const placeholders = uniqueSeatIds
        .map((_, i) => "$" + (i + 1))
        .join(", ");

      const { rows: seats } = await tx.query(
        "SELECT id, row_label, seat_number, status, hold_expires_at " +
          "FROM seats " +
          "WHERE id IN (" +
          placeholders +
          ") " +
          "FOR UPDATE",
        uniqueSeatIds
      );

      // Make sure we found all requested seats
      if (seats.length !== uniqueSeatIds.length) {
        const foundIds = new Set(
          seats.map((/** @type {any} */ s) => s.id)
        );
        const notFound = uniqueSeatIds.filter((id) => !foundIds.has(id));
        return {
          ok: false,
          status: 404,
          body: { error: "Seats not found", seatIds: notFound },
        };
      }

      // For each seat: determine its *effective* status (considering expiry)
      const conflicting = [];
      for (const seat of seats) {
        let effectiveStatus = seat.status;
        if (
          seat.status === "held" &&
          seat.hold_expires_at &&
          new Date(seat.hold_expires_at) <= new Date()
        ) {
          effectiveStatus = "available";
        }
        if (effectiveStatus !== "available") {
          conflicting.push({
            id: seat.id,
            row_label: seat.row_label,
            seat_number: seat.seat_number,
            status: effectiveStatus,
          });
        }
      }

      if (conflicting.length > 0) {
        return {
          ok: false,
          status: 409,
          body: { error: "Seats unavailable", conflicting },
        };
      }

      // All seats are available — acquire them atomically
      const pHoldId = "$" + (uniqueSeatIds.length + 1);
      const pExpiresAt = "$" + (uniqueSeatIds.length + 2);
      const pSessionId = "$" + (uniqueSeatIds.length + 3);

      await tx.query(
        "UPDATE seats " +
          "SET status = 'held', " +
          "hold_id = " +
          pHoldId +
          ", " +
          "hold_expires_at = " +
          pExpiresAt +
          ", " +
          "session_id = " +
          pSessionId +
          " " +
          "WHERE id IN (" +
          placeholders +
          ")",
        [...uniqueSeatIds, holdId, expiresAt.toISOString(), sessionId]
      );

      // Insert hold record
      await tx.query(
        "INSERT INTO holds (id, session_id, seat_ids, expires_at) VALUES ($1, $2, $3, $4)",
        [holdId, sessionId, uniqueSeatIds, expiresAt.toISOString()]
      );

      // Get the updated seats for the response
      const { rows: updatedSeats } = await tx.query(
        "SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id " +
          "FROM seats WHERE id IN (" +
          placeholders +
          ")",
        uniqueSeatIds
      );

      return { ok: true, holdId, expiresAt, seats: updatedSeats };
    });

    if (!result.ok) {
      return res.status(result.status).json(result.body);
    }

    // Broadcast the hold
    broadcast("seats-updated", {
      type: "held",
      holdId: result.holdId,
      seats: result.seats.map((/** @type {any} */ s) => ({
        id: s.id,
        row_label: s.row_label,
        seat_number: s.seat_number,
        status: s.status,
        hold_id: s.hold_id,
        hold_expires_at: s.hold_expires_at,
      })),
    });

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

/**
 * POST /api/holds/:holdId/confirm
 * Confirms a hold, booking the seats permanently.
 * Idempotent: confirming an already-confirmed hold returns the same result.
 */
router.post("/:holdId/confirm", async (req, res) => {
  try {
    const { holdId } = req.params;
    const db = await getDb();

    // Expire stale holds first
    await expireStaleHolds(db);

    const result = await db.transaction(async (/** @type {any} */ tx) => {
      // Look up the hold record with FOR UPDATE lock
      const { rows: holdRows } = await tx.query(
        "SELECT id, session_id, seat_ids, expires_at, status FROM holds WHERE id = $1 FOR UPDATE",
        [holdId]
      );

      if (holdRows.length === 0) {
        return { ok: false, status: 404, body: { error: "Hold not found" } };
      }

      const hold = holdRows[0];

      // Idempotent: if already confirmed, return the booking info
      if (hold.status === "confirmed") {
        const placeholders = hold.seat_ids
          .map((/** @type {any} */ _v, /** @type {number} */ i) => "$" + (i + 1))
          .join(", ");
        const { rows: bookedSeats } = await tx.query(
          "SELECT id, row_label, seat_number, status, booked_by, session_id " +
            "FROM seats WHERE id IN (" +
            placeholders +
            ")",
          hold.seat_ids
        );
        return {
          ok: true,
          alreadyConfirmed: true,
          holdId: hold.id,
          seats: bookedSeats,
        };
      }

      // Check if expired
      if (
        hold.status === "expired" ||
        new Date(hold.expires_at) <= new Date()
      ) {
        // Mark as expired if not already
        if (hold.status !== "expired") {
          await tx.query(
            "UPDATE holds SET status = 'expired' WHERE id = $1",
            [holdId]
          );
          // Release the seats that are still held by this hold
          const placeholders = hold.seat_ids
            .map(
              (/** @type {any} */ _v, /** @type {number} */ i) =>
                "$" + (i + 1)
            )
            .join(", ");
          await tx.query(
            "UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL " +
              "WHERE id IN (" +
              placeholders +
              ") AND hold_id = $" +
              (hold.seat_ids.length + 1),
            [...hold.seat_ids, holdId]
          );
        }
        return { ok: false, status: 410, body: { error: "Hold has expired" } };
      }

      // Check if released
      if (hold.status === "released") {
        return {
          ok: false,
          status: 410,
          body: { error: "Hold was released" },
        };
      }

      // Verify the seats are still held by this hold
      const seatIds = hold.seat_ids;
      const placeholders = seatIds
        .map(
          (/** @type {any} */ _v, /** @type {number} */ i) => "$" + (i + 1)
        )
        .join(", ");

      const { rows: heldSeats } = await tx.query(
        "SELECT id, row_label, seat_number, status, hold_id FROM seats " +
          "WHERE id IN (" +
          placeholders +
          ") FOR UPDATE",
        seatIds
      );

      // Verify all seats still belong to this hold
      const ownedSeats = heldSeats.filter(
        (/** @type {any} */ s) =>
          s.hold_id === holdId && s.status === "held"
      );
      if (ownedSeats.length !== seatIds.length) {
        return {
          ok: false,
          status: 409,
          body: { error: "Some seats are no longer held by this hold" },
        };
      }

      // Book the seats
      const pBookedBy = "$" + (seatIds.length + 1);
      const pHoldId = "$" + (seatIds.length + 2);

      await tx.query(
        "UPDATE seats SET status = 'booked', booked_by = " +
          pBookedBy +
          ", hold_expires_at = NULL " +
          "WHERE id IN (" +
          placeholders +
          ") AND hold_id = " +
          pHoldId,
        [...seatIds, hold.session_id, holdId]
      );

      // Mark hold as confirmed
      await tx.query("UPDATE holds SET status = 'confirmed' WHERE id = $1", [
        holdId,
      ]);

      // Get the updated seats
      const { rows: bookedSeats } = await tx.query(
        "SELECT id, row_label, seat_number, status, booked_by, session_id FROM seats " +
          "WHERE id IN (" +
          placeholders +
          ")",
        seatIds
      );

      return {
        ok: true,
        alreadyConfirmed: false,
        holdId: hold.id,
        seats: bookedSeats,
      };
    });

    if (!result.ok) {
      return res.status(result.status).json(result.body);
    }

    // Broadcast booking (only if newly confirmed)
    if (!result.alreadyConfirmed) {
      broadcast("seats-updated", {
        type: "booked",
        holdId: result.holdId,
        seats: result.seats.map((/** @type {any} */ s) => ({
          id: s.id,
          row_label: s.row_label,
          seat_number: s.seat_number,
          status: s.status,
        })),
      });
    }

    return res.json({
      holdId: result.holdId,
      seats: result.seats,
      alreadyConfirmed: result.alreadyConfirmed ?? false,
    });
  } catch (err) {
    console.error("POST /api/holds/:holdId/confirm error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * DELETE /api/holds/:holdId
 * Releases a hold early, returning its seats to available.
 */
router.delete("/:holdId", async (req, res) => {
  try {
    const { holdId } = req.params;
    const db = await getDb();

    const result = await db.transaction(async (/** @type {any} */ tx) => {
      // Look up the hold
      const { rows: holdRows } = await tx.query(
        "SELECT id, session_id, seat_ids, status FROM holds WHERE id = $1 FOR UPDATE",
        [holdId]
      );

      if (holdRows.length === 0) {
        return { ok: false, status: 404, body: { error: "Hold not found" } };
      }

      const hold = holdRows[0];

      // Can't release a confirmed hold
      if (hold.status === "confirmed") {
        return {
          ok: false,
          status: 400,
          body: { error: "Hold is already confirmed (booked)" },
        };
      }

      // If already released or expired, return success (idempotent)
      if (hold.status === "released" || hold.status === "expired") {
        return { ok: true, alreadyReleased: true, seats: [] };
      }

      // Release the seats
      const seatIds = hold.seat_ids;
      const placeholders = seatIds
        .map(
          (/** @type {any} */ _v, /** @type {number} */ i) => "$" + (i + 1)
        )
        .join(", ");
      const pHoldId = "$" + (seatIds.length + 1);

      const { rows: releasedSeats } = await tx.query(
        "UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL " +
          "WHERE id IN (" +
          placeholders +
          ") AND hold_id = " +
          pHoldId +
          " RETURNING id, row_label, seat_number",
        [...seatIds, holdId]
      );

      // Mark hold as released
      await tx.query("UPDATE holds SET status = 'released' WHERE id = $1", [
        holdId,
      ]);

      return { ok: true, alreadyReleased: false, seats: releasedSeats };
    });

    if (!result.ok) {
      return res.status(result.status).json(result.body);
    }

    if (!result.alreadyReleased && result.seats.length > 0) {
      broadcast("seats-updated", {
        type: "released",
        holdId,
        seats: result.seats.map((/** @type {any} */ s) => ({
          id: s.id,
          row_label: s.row_label,
          seat_number: s.seat_number,
          status: "available",
        })),
      });
    }

    return res.json({ released: true, seats: result.seats });
  } catch (err) {
    console.error("DELETE /api/holds/:holdId error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
