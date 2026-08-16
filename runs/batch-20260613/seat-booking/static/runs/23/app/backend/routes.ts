import { Router, Request, Response } from "express";
import { PGlite } from "@electric-sql/pglite";
import { v4 as uuidv4 } from "uuid";
import { addClient, broadcastSeatUpdates } from "./sse.ts";
import { releaseExpiredHolds } from "./expiry.ts";

const HOLD_TTL_SECONDS = 30;

interface SeatRow {
  id: number;
  row_label: string;
  seat_number: number;
  status: string;
  hold_id: string | null;
  hold_expires_at: string | null;
  booked_by: string | null;
}

interface HoldRow {
  id: string;
  session_id: string;
  seat_ids: number[];
  expires_at: string;
  status: string;
  confirmed_at: string | null;
}

function effectiveStatus(seat: { status: string; hold_expires_at: string | null }): string {
  if (
    seat.status === "held" &&
    seat.hold_expires_at &&
    new Date(seat.hold_expires_at) <= new Date()
  ) {
    return "available";
  }
  return seat.status;
}

export function createRouter(db: PGlite): Router {
  const router = Router();

  // SSE endpoint
  router.get("/stream", (req: Request, res: Response) => {
    addClient(req, res);
  });

  // GET /api/seats
  router.get("/seats", async (_req: Request, res: Response) => {
    try {
      await releaseExpiredHolds(db);

      const result = await db.query<SeatRow>(
        "SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by FROM seats ORDER BY row_label, seat_number"
      );

      const seats = result.rows.map((seat) => {
        const eff = effectiveStatus(seat);
        return {
          id: seat.id,
          rowLabel: seat.row_label,
          seatNumber: seat.seat_number,
          status: eff,
          holdId: eff === "available" ? null : seat.hold_id,
          holdExpiresAt: eff === "held" ? seat.hold_expires_at : null,
          bookedBy: eff === "booked" ? seat.booked_by : null,
        };
      });

      res.json({ seats });
    } catch (err) {
      console.error("GET /seats error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/holds
  router.post("/holds", async (req: Request, res: Response) => {
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

    if (!seatIds.every((id: unknown) => typeof id === "number" && Number.isInteger(id))) {
      res.status(400).json({ error: "seatIds must be an array of integers" });
      return;
    }

    try {
      await releaseExpiredHolds(db);

      const holdId = uuidv4();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

      const result = await db.transaction(async (tx) => {
        const lockResult = await tx.query<SeatRow>(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
           FROM seats
           WHERE id = ANY($1::int[])
           ORDER BY id
           FOR UPDATE`,
          [seatIds]
        );

        if (lockResult.rows.length !== seatIds.length) {
          const foundIds = new Set(lockResult.rows.map((r) => r.id));
          const missingIds = (seatIds as number[]).filter((id) => !foundIds.has(id));
          return { error: "invalid_seats" as const, missingIds };
        }

        const unavailable: number[] = [];
        for (const seat of lockResult.rows) {
          if (effectiveStatus(seat) !== "available") {
            unavailable.push(seat.id);
          }
        }

        if (unavailable.length > 0) {
          return { error: "conflict" as const, unavailable };
        }

        // Release expired-but-still-marked seats within this transaction
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

        await tx.query(
          `UPDATE seats
           SET status = 'held',
               hold_id = $1,
               hold_expires_at = $2::timestamptz
           WHERE id = ANY($3::int[])`,
          [holdId, expiresAt, seatIds]
        );

        await tx.query(
          `INSERT INTO holds (id, session_id, seat_ids, expires_at, status)
           VALUES ($1, $2, $3::int[], $4::timestamptz, 'active')`,
          [holdId, sessionId, seatIds, expiresAt]
        );

        return { success: true as const };
      });

      if ("error" in result) {
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
      }

      const updatedSeats = await db.query<SeatRow>(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
         FROM seats WHERE id = ANY($1::int[])`,
        [seatIds]
      );

      broadcastSeatUpdates(
        updatedSeats.rows.map((s) => ({
          seatId: s.id,
          rowLabel: s.row_label,
          seatNumber: s.seat_number,
          status: "held" as const,
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

  // POST /api/holds/:holdId/confirm
  router.post("/holds/:holdId/confirm", async (req: Request, res: Response) => {
    const { holdId } = req.params;

    try {
      await releaseExpiredHolds(db);

      const result = await db.transaction(async (tx) => {
        const holdResult = await tx.query<HoldRow>(
          `SELECT id, session_id, seat_ids, expires_at, status, confirmed_at
           FROM holds
           WHERE id = $1
           FOR UPDATE`,
          [holdId]
        );

        if (holdResult.rows.length === 0) {
          return { error: "not_found" as const };
        }

        const hold = holdResult.rows[0];

        if (hold.status === "confirmed") {
          return {
            success: true as const,
            idempotent: true as const,
            hold: {
              id: hold.id,
              sessionId: hold.session_id,
              seatIds: hold.seat_ids,
              status: "confirmed" as const,
              confirmedAt: hold.confirmed_at,
            },
          };
        }

        if (hold.status === "expired" || new Date(hold.expires_at) <= new Date()) {
          if (hold.status === "active") {
            await tx.query(
              `UPDATE holds SET status = 'expired' WHERE id = $1`,
              [holdId]
            );
            await tx.query(
              `UPDATE seats
               SET status = 'available', hold_id = NULL, hold_expires_at = NULL
               WHERE hold_id = $1 AND status = 'held'`,
              [holdId]
            );
          }
          return { error: "expired" as const };
        }

        if (hold.status === "released") {
          return { error: "released" as const };
        }

        const seatsResult = await tx.query<SeatRow>(
          `SELECT id, row_label, seat_number, status, hold_id
           FROM seats
           WHERE id = ANY($1::int[])
           ORDER BY id
           FOR UPDATE`,
          [hold.seat_ids]
        );

        for (const seat of seatsResult.rows) {
          if (seat.status !== "held" || seat.hold_id !== holdId) {
            return { error: "seats_lost" as const };
          }
        }

        const confirmedAt = new Date().toISOString();

        await tx.query(
          `UPDATE seats
           SET status = 'booked',
               hold_id = NULL,
               hold_expires_at = NULL,
               booked_by = $1
           WHERE id = ANY($2::int[])`,
          [hold.session_id, hold.seat_ids]
        );

        await tx.query(
          `UPDATE holds SET status = 'confirmed', confirmed_at = $1::timestamptz WHERE id = $2`,
          [confirmedAt, holdId]
        );

        return {
          success: true as const,
          idempotent: false as const,
          hold: {
            id: hold.id,
            sessionId: hold.session_id,
            seatIds: hold.seat_ids,
            status: "confirmed" as const,
            confirmedAt,
          },
          seats: seatsResult.rows,
        };
      });

      if ("error" in result) {
        switch (result.error) {
          case "not_found":
            res.status(404).json({ error: "Hold not found" });
            return;
          case "expired":
            res.status(410).json({ error: "Hold has expired" });
            return;
          case "released":
            res.status(410).json({ error: "Hold was released" });
            return;
          case "seats_lost":
            res.status(409).json({ error: "Seats are no longer held by this hold" });
            return;
        }
      }

      if ("success" in result) {
        if (!result.idempotent && "seats" in result && result.seats) {
          broadcastSeatUpdates(
            result.seats.map((s) => ({
              seatId: s.id,
              rowLabel: s.row_label,
              seatNumber: s.seat_number,
              status: "booked" as const,
              holdId: null,
              holdExpiresAt: null,
            }))
          );
        }

        res.json({ booking: result.hold });
      }
    } catch (err) {
      console.error("POST /holds/:holdId/confirm error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /api/holds/:holdId
  router.delete("/holds/:holdId", async (req: Request, res: Response) => {
    const { holdId } = req.params;

    try {
      const result = await db.transaction(async (tx) => {
        const holdResult = await tx.query<HoldRow>(
          `SELECT id, session_id, seat_ids, expires_at, status
           FROM holds
           WHERE id = $1
           FOR UPDATE`,
          [holdId]
        );

        if (holdResult.rows.length === 0) {
          return { error: "not_found" as const };
        }

        const hold = holdResult.rows[0];

        if (hold.status === "confirmed") {
          return { error: "already_confirmed" as const };
        }

        if (hold.status === "released" || hold.status === "expired") {
          return {
            success: true as const,
            alreadyReleased: true as const,
            seatIds: hold.seat_ids,
          };
        }

        const releasedSeats = await tx.query<SeatRow>(
          `UPDATE seats
           SET status = 'available',
               hold_id = NULL,
               hold_expires_at = NULL
           WHERE hold_id = $1 AND status = 'held'
           RETURNING id, row_label, seat_number`,
          [holdId]
        );

        await tx.query(
          `UPDATE holds SET status = 'released' WHERE id = $1`,
          [holdId]
        );

        return {
          success: true as const,
          alreadyReleased: false as const,
          seats: releasedSeats.rows,
          seatIds: hold.seat_ids,
        };
      });

      if ("error" in result) {
        switch (result.error) {
          case "not_found":
            res.status(404).json({ error: "Hold not found" });
            return;
          case "already_confirmed":
            res.status(409).json({ error: "Hold is already confirmed and cannot be released" });
            return;
        }
      }

      if ("success" in result) {
        if (!result.alreadyReleased && "seats" in result && result.seats) {
          broadcastSeatUpdates(
            result.seats.map((s) => ({
              seatId: s.id,
              rowLabel: s.row_label,
              seatNumber: s.seat_number,
              status: "available" as const,
              holdId: null,
              holdExpiresAt: null,
            }))
          );
        }

        res.json({ released: true, seatIds: result.seatIds });
      }
    } catch (err) {
      console.error("DELETE /holds/:holdId error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
