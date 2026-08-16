import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import { addClient, broadcast } from "./sse.js";
import { expireStaleHolds, setSweepMutex } from "./expiry.js";

const router = Router();

const HOLD_TTL_SECONDS = parseInt(process.env.HOLD_TTL_SECONDS || "30", 10);

// Serialize all mutating operations to avoid race conditions in PGLite
let mutexQueue = Promise.resolve();

export function withMutex(fn) {
  // Chain fn after the previous operation completes (whether it succeeded or failed)
  const p = mutexQueue.then(() => fn());
  // Keep the chain alive regardless of whether fn succeeded or failed
  mutexQueue = p.then(() => {}, () => {});
  return p;
}

// Give the periodic sweep access to our mutex
setSweepMutex(withMutex);

// ── SSE endpoint ────────────────────────────────────────────────────────────
router.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(":\n\n"); // comment to flush headers
  addClient(res);
});

// ── GET /seats – return all seats with effective status ─────────────────────
router.get("/seats", async (req, res) => {
  try {
    // Use mutex so expiry + read is atomic
    const seats = await withMutex(async () => {
      await expireStaleHolds();

      const db = await getDb();
      const result = await db.query(`
        SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
        FROM seats
        ORDER BY row_label, seat_number
      `);

      return result.rows.map((row) => ({
        id: row.id,
        rowLabel: row.row_label,
        seatNumber: row.seat_number,
        status: row.status,
        holdId: row.hold_id,
        holdExpiresAt: row.hold_expires_at,
        sessionId: row.session_id,
        bookedBy: row.booked_by,
      }));
    });

    res.json({ seats });
  } catch (err) {
    console.error("GET /seats error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /holds – atomically hold seats ─────────────────────────────────────
router.post("/holds", async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: "seatIds must be a non-empty array" });
  }
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required" });
  }

  try {
    const result = await withMutex(async () => {
      const db = await getDb();

      // Expire stale holds first
      await expireStaleHolds();

      const holdId = uuidv4();
      const sortedIds = [...seatIds].sort((a, b) => a - b);

      // Check all requested seats exist and are available
      const placeholders = sortedIds.map((_, i) => `$${i + 1}`).join(", ");
      const check = await db.query(
        `SELECT id, status, hold_id, hold_expires_at
         FROM seats
         WHERE id IN (${placeholders})`,
        sortedIds
      );

      if (check.rows.length !== sortedIds.length) {
        const foundIds = new Set(check.rows.map((r) => r.id));
        const notFound = sortedIds.filter((id) => !foundIds.has(id));
        return {
          ok: false,
          status: 400,
          body: { error: "Some seat IDs do not exist", invalidSeatIds: notFound },
        };
      }

      // Check all seats are available
      const unavailable = check.rows.filter((r) => r.status !== "available");
      if (unavailable.length > 0) {
        return {
          ok: false,
          status: 409,
          body: {
            error: "Some seats are not available",
            conflictingSeatIds: unavailable.map((r) => r.id),
          },
        };
      }

      // All seats are available – acquire them
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

      const updatePlaceholders = sortedIds.map((_, i) => `$${i + 4}`).join(", ");
      await db.query(
        `UPDATE seats
         SET status = 'held',
             hold_id = $1,
             hold_expires_at = $2::timestamptz,
             session_id = $3
         WHERE id IN (${updatePlaceholders})`,
        [holdId, expiresAt, sessionId, ...sortedIds]
      );

      // Create hold record - store seat_ids as JSON text to avoid array type issues
      await db.query(
        `INSERT INTO holds (id, session_id, seat_ids_json, expires_at)
         VALUES ($1, $2, $3, $4::timestamptz)`,
        [holdId, sessionId, JSON.stringify(sortedIds), expiresAt]
      );

      return {
        ok: true,
        hold: {
          holdId,
          sessionId,
          seatIds: sortedIds,
          expiresAt,
        },
      };
    });

    if (!result.ok) {
      return res.status(result.status).json(result.body);
    }

    // Broadcast the held seats
    const db = await getDb();
    const heldSeatsResult = await db.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id
       FROM seats WHERE hold_id = $1`,
      [result.hold.holdId]
    );

    const seatUpdates = heldSeatsResult.rows.map((r) => ({
      seatId: r.id,
      rowLabel: r.row_label,
      seatNumber: r.seat_number,
      status: r.status,
      holdId: r.hold_id,
      holdExpiresAt: r.hold_expires_at,
      sessionId: r.session_id,
    }));

    broadcast("seatUpdates", seatUpdates);

    res.status(201).json(result.hold);
  } catch (err) {
    console.error("POST /holds error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /holds/:holdId/confirm – confirm a hold ───────────────────────────
router.post("/holds/:holdId/confirm", async (req, res) => {
  const { holdId } = req.params;

  try {
    const result = await withMutex(async () => {
      const db = await getDb();

      // Expire stale holds first
      await expireStaleHolds();

      // Look up the hold
      const holdResult = await db.query(
        `SELECT id, session_id, seat_ids_json, expires_at, status
         FROM holds
         WHERE id = $1`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        return {
          ok: false,
          status: 404,
          body: { error: "Hold not found" },
        };
      }

      const hold = holdResult.rows[0];
      const seatIds = JSON.parse(hold.seat_ids_json);

      // Idempotent: if already confirmed, return success
      if (hold.status === "confirmed") {
        return {
          ok: true,
          alreadyConfirmed: true,
          booking: {
            holdId: hold.id,
            sessionId: hold.session_id,
            seatIds,
            status: "confirmed",
          },
        };
      }

      // Check if expired
      if (hold.status === "expired" || new Date(hold.expires_at) <= new Date()) {
        // Mark as expired if not already
        if (hold.status !== "expired") {
          await db.query(
            `UPDATE holds SET status = 'expired' WHERE id = $1`,
            [holdId]
          );
          // Release seats that this hold still owns
          if (seatIds && seatIds.length > 0) {
            const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
            await db.query(
              `UPDATE seats
               SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
               WHERE id IN (${placeholders}) AND hold_id = $${seatIds.length + 1}`,
              [...seatIds, holdId]
            );
          }
        }
        return {
          ok: false,
          status: 410,
          body: { error: "Hold has expired" },
        };
      }

      // Check if released
      if (hold.status === "released") {
        return {
          ok: false,
          status: 410,
          body: { error: "Hold was released" },
        };
      }

      // Verify all seats are still held by this hold
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
      const seatsCheck = await db.query(
        `SELECT id, status, hold_id
         FROM seats
         WHERE id IN (${placeholders})`,
        seatIds
      );

      const allOwnedAndHeld = seatsCheck.rows.every(
        (s) => s.status === "held" && s.hold_id === holdId
      );

      if (!allOwnedAndHeld || seatsCheck.rows.length !== seatIds.length) {
        await db.query(
          `UPDATE holds SET status = 'expired' WHERE id = $1`,
          [holdId]
        );
        return {
          ok: false,
          status: 409,
          body: { error: "Hold is no longer valid; some seats were released" },
        };
      }

      // Book the seats
      await db.query(
        `UPDATE seats
         SET status = 'booked',
             booked_by = $1,
             hold_expires_at = NULL
         WHERE hold_id = $2`,
        [holdId, holdId]
      );

      // Mark hold as confirmed
      await db.query(
        `UPDATE holds SET status = 'confirmed' WHERE id = $1`,
        [holdId]
      );

      return {
        ok: true,
        alreadyConfirmed: false,
        booking: {
          holdId: hold.id,
          sessionId: hold.session_id,
          seatIds,
          status: "confirmed",
        },
      };
    });

    if (!result.ok) {
      return res.status(result.status).json(result.body);
    }

    // Broadcast booked seats (only if newly confirmed)
    if (!result.alreadyConfirmed) {
      const db = await getDb();
      const bookedResult = await db.query(
        `SELECT id, row_label, seat_number, status, hold_id, session_id, booked_by
         FROM seats WHERE booked_by = $1`,
        [holdId]
      );

      const seatUpdates = bookedResult.rows.map((r) => ({
        seatId: r.id,
        rowLabel: r.row_label,
        seatNumber: r.seat_number,
        status: r.status,
        holdId: r.hold_id,
        holdExpiresAt: null,
        sessionId: r.session_id,
        bookedBy: r.booked_by,
      }));

      broadcast("seatUpdates", seatUpdates);
    }

    res.json(result.booking);
  } catch (err) {
    console.error("POST /holds/:holdId/confirm error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── DELETE /holds/:holdId – release a hold early ────────────────────────────
router.delete("/holds/:holdId", async (req, res) => {
  const { holdId } = req.params;

  try {
    const result = await withMutex(async () => {
      const db = await getDb();

      // Look up the hold
      const holdResult = await db.query(
        `SELECT id, session_id, seat_ids_json, expires_at, status
         FROM holds
         WHERE id = $1`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        return {
          ok: false,
          status: 404,
          body: { error: "Hold not found" },
        };
      }

      const hold = holdResult.rows[0];
      const seatIds = JSON.parse(hold.seat_ids_json);

      if (hold.status === "confirmed") {
        return {
          ok: false,
          status: 400,
          body: { error: "Cannot release a confirmed hold" },
        };
      }

      if (hold.status === "released") {
        return { ok: true, alreadyReleased: true };
      }

      // Release the seats
      if (seatIds && seatIds.length > 0) {
        const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(", ");
        await db.query(
          `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
           WHERE id IN (${placeholders}) AND hold_id = $${seatIds.length + 1}`,
          [...seatIds, holdId]
        );
      }

      // Mark hold as released
      await db.query(
        `UPDATE holds SET status = 'released' WHERE id = $1`,
        [holdId]
      );

      return { ok: true, alreadyReleased: false, seatIds };
    });

    if (!result.ok) {
      return res.status(result.status).json(result.body);
    }

    // Broadcast released seats
    if (!result.alreadyReleased && result.seatIds) {
      const db = await getDb();
      const placeholders = result.seatIds.map((_, i) => `$${i + 1}`).join(", ");
      const releasedResult = await db.query(
        `SELECT id, row_label, seat_number, status, hold_id, session_id
         FROM seats WHERE id IN (${placeholders})`,
        result.seatIds
      );

      const seatUpdates = releasedResult.rows.map((r) => ({
        seatId: r.id,
        rowLabel: r.row_label,
        seatNumber: r.seat_number,
        status: r.status,
        holdId: r.hold_id,
        holdExpiresAt: null,
        sessionId: r.session_id,
      }));

      broadcast("seatUpdates", seatUpdates);
    }

    res.json({ message: "Hold released" });
  } catch (err) {
    console.error("DELETE /holds/:holdId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /inventory – exact inventory counts ─────────────────────────────────
router.get("/inventory", async (req, res) => {
  try {
    const inventory = await withMutex(async () => {
      await expireStaleHolds();

      const db = await getDb();
      const result = await db.query(`
        SELECT status, COUNT(*) as count
        FROM seats
        GROUP BY status
      `);

      const inv = { available: 0, held: 0, booked: 0, total: 0 };
      for (const row of result.rows) {
        inv[row.status] = parseInt(row.count, 10);
      }
      inv.total = inv.available + inv.held + inv.booked;
      return inv;
    });

    res.json(inventory);
  } catch (err) {
    console.error("GET /inventory error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
