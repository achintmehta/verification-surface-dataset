import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { addClient, broadcastSeatUpdates } from "./sse.js";
import { releaseExpiredHolds } from "./expiry.js";

const HOLD_TTL_SECONDS = 30;

/**
 * Compute the effective status of a seat. If it's held but the hold has expired,
 * treat it as available.
 * @param {{ status: string; hold_expires_at: string | null }} seat
 * @returns {string}
 */
function effectiveStatus(seat) {
  if (
    seat.status === "held" &&
    seat.hold_expires_at &&
    new Date(seat.hold_expires_at) <= new Date()
  ) {
    return "available";
  }
  return seat.status;
}

/**
 * @param {import('@electric-sql/pglite').PGlite} db
 * @returns {Router}
 */
export function createRouter(db) {
  const router = Router();

  // SSE endpoint
  router.get("/stream", (req, res) => {
    addClient(req, res);
  });

  // GET /api/seats — return all seats with effective status
  router.get("/seats", async (_req, res) => {
    try {
      // Release expired holds first
      await releaseExpiredHolds(db);

      const result = await db.query(
        "SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by FROM seats ORDER BY row_label, seat_number"
      );

      const seats = result.rows.map((seat) => ({
        id: seat.id,
        rowLabel: seat.row_label,
        seatNumber: seat.seat_number,
        status: effectiveStatus(seat),
        holdId: effectiveStatus(seat) === "available" ? null : seat.hold_id,
        holdExpiresAt:
          effectiveStatus(seat) === "held" ? seat.hold_expires_at : null,
        bookedBy:
          effectiveStatus(seat) === "booked" ? seat.booked_by : null,
      }));

      res.json({ seats });
    } catch (err) {
      console.error("GET /seats error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/holds — atomically hold seats
  router.post("/holds", async (req, res) => {
    const { seatIds, sessionId } = req.body;

    if (
      !Array.isArray(seatIds) ||
      seatIds.length === 0 ||
      !sessionId ||
      typeof sessionId !== "string"
    ) {
      res.status(400).json({
        error: "seatIds (non-empty array) and sessionId (string) are required",
      });
      return;
    }

    // Validate seat IDs are all numbers
    if (
      !seatIds.every(
        (id) => typeof id === "number" && Number.isInteger(id)
      )
    ) {
      res.status(400).json({ error: "seatIds must be an array of integers" });
      return;
    }

    try {
      // Release expired holds first
      await releaseExpiredHolds(db);

      const holdId = uuidv4();
      const expiresAt = new Date(
        Date.now() + HOLD_TTL_SECONDS * 1000
      ).toISOString();

      const result = await db.transaction(async (tx) => {
        // Lock the requested seats with FOR UPDATE to prevent concurrent modifications
        const lockResult = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
           FROM seats
           WHERE id = ANY($1::int[])
           ORDER BY id
           FOR UPDATE`,
          [seatIds]
        );

        if (lockResult.rows.length !== seatIds.length) {
          const foundIds = new Set(lockResult.rows.map((r) => r.id));
          const missingIds = seatIds.filter((id) => !foundIds.has(id));
          return { error: "invalid_seats", missingIds };
        }

        // Check all seats are available (considering expiry)
        const unavailable = [];
        for (const seat of lockResult.rows) {
          const eff = effectiveStatus(seat);
          if (eff !== "available") {
            unavailable.push(seat.id);
          }
        }

        if (unavailable.length > 0) {
          return { error: "conflict", unavailable };
        }

        // Release any seats that were expired (they passed effectiveStatus check
        // but still have 'held' status in the DB row)
        for (const seat of lockResult.rows) {
          if (
            seat.status === "held" &&
            seat.hold_expires_at &&
            new Date(seat.hold_expires_at) <= new Date()
          ) {
            await tx.query(
              `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL WHERE id = $1`,
              [seat.id]
            );
            if (seat.hold_id) {
              await tx.query(
                `UPDATE holds SET status = 'expired' WHERE id = $1 AND status = 'active'`,
                [seat.hold_id]
              );
            }
          }
        }

        // Now mark all seats as held
        await tx.query(
          `UPDATE seats
           SET status = 'held',
               hold_id = $1,
               hold_expires_at = $2::timestamptz
           WHERE id = ANY($3::int[])`,
          [holdId, expiresAt, seatIds]
        );

        // Create the hold record
        await tx.query(
          `INSERT INTO holds (id, session_id, seat_ids, expires_at, status)
           VALUES ($1, $2, $3::int[], $4::timestamptz, 'active')`,
          [holdId, sessionId, seatIds, expiresAt]
        );

        return { success: true };
      });

      if (result.error === "invalid_seats") {
        res.status(400).json({
          error: "Some seat IDs do not exist",
          missingIds: result.missingIds,
        });
        return;
      }
      if (result.error === "conflict") {
        res.status(409).json({
          error: "Some seats are not available",
          conflictingSeatIds: result.unavailable,
        });
        return;
      }

      // Fetch the updated seats for broadcasting
      const updatedSeats = await db.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
         FROM seats WHERE id = ANY($1::int[])`,
        [seatIds]
      );

      broadcastSeatUpdates(
        updatedSeats.rows.map((s) => ({
          seatId: s.id,
          rowLabel: s.row_label,
          seatNumber: s.seat_number,
          status: "held",
          holdId: s.hold_id,
          holdExpiresAt: s.hold_expires_at,
        }))
      );

      res.status(201).json({
        hold: {
          id: holdId,
          sessionId,
          seatIds,
          expiresAt,
          status: "active",
        },
      });
    } catch (err) {
      console.error("POST /holds error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/holds/:holdId/confirm — confirm a hold
  router.post("/holds/:holdId/confirm", async (req, res) => {
    const { holdId } = req.params;

    try {
      // Release expired holds first
      await releaseExpiredHolds(db);

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
          return { error: "not_found" };
        }

        const hold = holdResult.rows[0];

        // Idempotent: if already confirmed, return success
        if (hold.status === "confirmed") {
          return {
            success: true,
            idempotent: true,
            hold: {
              id: hold.id,
              sessionId: hold.session_id,
              seatIds: hold.seat_ids,
              status: "confirmed",
              confirmedAt: hold.confirmed_at,
            },
          };
        }

        // Check if expired
        if (
          hold.status === "expired" ||
          new Date(hold.expires_at) <= new Date()
        ) {
          // If the hold status hasn't been updated yet, update it
          if (hold.status === "active") {
            await tx.query(
              `UPDATE holds SET status = 'expired' WHERE id = $1`,
              [holdId]
            );
            // Release the seats
            await tx.query(
              `UPDATE seats
               SET status = 'available', hold_id = NULL, hold_expires_at = NULL
               WHERE hold_id = $1 AND status = 'held'`,
              [holdId]
            );
          }
          return { error: "expired" };
        }

        // Check if released
        if (hold.status === "released") {
          return { error: "released" };
        }

        // Verify the seats are still held by this hold
        const seatsResult = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id
           FROM seats
           WHERE id = ANY($1::int[])
           ORDER BY id
           FOR UPDATE`,
          [hold.seat_ids]
        );

        // Verify all seats are held by this hold
        for (const seat of seatsResult.rows) {
          if (seat.status !== "held" || seat.hold_id !== holdId) {
            return { error: "seats_lost" };
          }
        }

        const confirmedAt = new Date().toISOString();

        // Book the seats
        await tx.query(
          `UPDATE seats
           SET status = 'booked',
               hold_id = NULL,
               hold_expires_at = NULL,
               booked_by = $1
           WHERE id = ANY($2::int[])`,
          [hold.session_id, hold.seat_ids]
        );

        // Mark hold as confirmed
        await tx.query(
          `UPDATE holds SET status = 'confirmed', confirmed_at = $1::timestamptz WHERE id = $2`,
          [confirmedAt, holdId]
        );

        return {
          success: true,
          idempotent: false,
          hold: {
            id: hold.id,
            sessionId: hold.session_id,
            seatIds: hold.seat_ids,
            status: "confirmed",
            confirmedAt,
          },
          seats: seatsResult.rows,
        };
      });

      if (result.error === "not_found") {
        res.status(404).json({ error: "Hold not found" });
        return;
      }
      if (result.error === "expired") {
        res.status(410).json({ error: "Hold has expired" });
        return;
      }
      if (result.error === "released") {
        res.status(410).json({ error: "Hold was released" });
        return;
      }
      if (result.error === "seats_lost") {
        res
          .status(409)
          .json({ error: "Seats are no longer held by this hold" });
        return;
      }

      // Broadcast if not idempotent (first confirmation)
      if (!result.idempotent && result.seats) {
        broadcastSeatUpdates(
          result.seats.map((s) => ({
            seatId: s.id,
            rowLabel: s.row_label,
            seatNumber: s.seat_number,
            status: "booked",
            holdId: null,
            holdExpiresAt: null,
          }))
        );
      }

      res.json({
        booking: result.hold,
      });
    } catch (err) {
      console.error("POST /holds/:holdId/confirm error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /api/holds/:holdId — release a hold early
  router.delete("/holds/:holdId", async (req, res) => {
    const { holdId } = req.params;

    try {
      const result = await db.transaction(async (tx) => {
        const holdResult = await tx.query(
          `SELECT id, session_id, seat_ids, expires_at, status
           FROM holds
           WHERE id = $1
           FOR UPDATE`,
          [holdId]
        );

        if (holdResult.rows.length === 0) {
          return { error: "not_found" };
        }

        const hold = holdResult.rows[0];

        if (hold.status === "confirmed") {
          return { error: "already_confirmed" };
        }

        if (hold.status === "released" || hold.status === "expired") {
          // Idempotent: already released
          return {
            success: true,
            alreadyReleased: true,
            seatIds: hold.seat_ids,
          };
        }

        // Release the seats
        const releasedSeats = await tx.query(
          `UPDATE seats
           SET status = 'available',
               hold_id = NULL,
               hold_expires_at = NULL
           WHERE hold_id = $1 AND status = 'held'
           RETURNING id, row_label, seat_number`,
          [holdId]
        );

        // Mark hold as released
        await tx.query(
          `UPDATE holds SET status = 'released' WHERE id = $1`,
          [holdId]
        );

        return {
          success: true,
          alreadyReleased: false,
          seats: releasedSeats.rows,
          seatIds: hold.seat_ids,
        };
      });

      if (result.error === "not_found") {
        res.status(404).json({ error: "Hold not found" });
        return;
      }
      if (result.error === "already_confirmed") {
        res
          .status(409)
          .json({
            error: "Hold is already confirmed and cannot be released",
          });
        return;
      }

      // Broadcast released seats
      if (!result.alreadyReleased && result.seats) {
        broadcastSeatUpdates(
          result.seats.map((s) => ({
            seatId: s.id,
            rowLabel: s.row_label,
            seatNumber: s.seat_number,
            status: "available",
            holdId: null,
            holdExpiresAt: null,
          }))
        );
      }

      res.json({ released: true, seatIds: result.seatIds });
    } catch (err) {
      console.error("DELETE /holds/:holdId error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
