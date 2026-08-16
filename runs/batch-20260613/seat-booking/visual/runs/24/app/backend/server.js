import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import { initDb, getDb } from "./db.js";
import { addClient, broadcast } from "./sse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3001;
const HOLD_TTL_SECONDS = parseInt(process.env.HOLD_TTL_SECONDS || "60", 10);

app.use(cors());
app.use(express.json());

// Serve frontend static files
app.use(express.static(path.join(__dirname, "..", "frontend")));

// ────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────

/**
 * Expire stale holds. This runs lazily before reads and mutations,
 * and also on a periodic sweep. Returns the list of seat updates broadcast.
 */
async function expireStaleHolds(db) {
  // Find seats whose holds have expired and are still marked as held
  const staleSeats = await db.query(`
    SELECT s.id, s.row_label, s.seat_number, s.hold_id
    FROM seats s
    WHERE s.status = 'held'
      AND s.hold_expires_at IS NOT NULL
      AND s.hold_expires_at <= NOW()
  `);

  if (staleSeats.rows.length === 0) return [];

  // Collect unique hold_ids to mark as expired
  const holdIds = [...new Set(staleSeats.rows.map(r => r.hold_id).filter(Boolean))];

  // Release those seats
  const seatIds = staleSeats.rows.map(r => r.id);
  await db.query(`
    UPDATE seats
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
    WHERE id = ANY($1::int[])
      AND status = 'held'
      AND hold_expires_at <= NOW()
  `, [seatIds]);

  // Mark holds as expired
  if (holdIds.length > 0) {
    await db.query(`
      UPDATE holds SET status = 'expired'
      WHERE id = ANY($1::text[])
        AND status = 'active'
    `, [holdIds]);
  }

  // Build updates for broadcast
  const updates = staleSeats.rows.map(r => ({
    id: r.id,
    row_label: r.row_label,
    seat_number: r.seat_number,
    status: "available",
    hold_id: null,
    hold_expires_at: null,
    session_id: null,
    booked_by: null,
  }));

  if (updates.length > 0) {
    broadcast("seatUpdate", updates);
  }

  return updates;
}

/**
 * Return effective status of a seat row from DB.
 * If it's held but expired, treat as available.
 */
function effectiveSeat(row) {
  if (
    row.status === "held" &&
    row.hold_expires_at &&
    new Date(row.hold_expires_at) <= new Date()
  ) {
    return {
      ...row,
      status: "available",
      hold_id: null,
      hold_expires_at: null,
      session_id: null,
    };
  }
  return row;
}

// ────────────────────────────────────────────
// Routes
// ────────────────────────────────────────────

// GET /api/seats — return all seats with effective statuses
app.get("/api/seats", async (req, res) => {
  try {
    const db = await getDb();
    await expireStaleHolds(db);
    const result = await db.query(
      "SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by FROM seats ORDER BY row_label, seat_number"
    );
    const seats = result.rows.map(effectiveSeat);
    res.json({ seats });
  } catch (err) {
    console.error("GET /api/seats error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/holds — atomically hold seats
app.post("/api/holds", async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: "seatIds must be a non-empty array" });
  }
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required" });
  }

  try {
    const db = await getDb();

    // Expire stale holds first
    await expireStaleHolds(db);

    const holdId = uuidv4();
    const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

    // Use a transaction with serialized seat locking
    // We do this by:
    // 1. SELECT ... FOR UPDATE to lock the rows
    // 2. Check all are available
    // 3. If any not available, rollback (409)
    // 4. Otherwise, update all and commit

    // PGlite supports transactions via db.transaction()
    let result;
    try {
      result = await db.transaction(async (tx) => {
        // Lock the requested seats (ORDER BY to avoid deadlocks)
        const lockResult = await tx.query(`
          SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
          FROM seats
          WHERE id = ANY($1::int[])
          ORDER BY id
          FOR UPDATE
        `, [seatIds]);

        if (lockResult.rows.length !== seatIds.length) {
          const foundIds = lockResult.rows.map(r => r.id);
          const missing = seatIds.filter(id => !foundIds.includes(id));
          throw { type: "not_found", missing };
        }

        // Check availability — treat expired holds as available
        const conflicting = [];
        for (const row of lockResult.rows) {
          const eff = effectiveSeat(row);
          if (eff.status !== "available") {
            conflicting.push({
              id: row.id,
              row_label: row.row_label,
              seat_number: row.seat_number,
              status: eff.status,
            });
          }
        }

        if (conflicting.length > 0) {
          throw { type: "conflict", conflicting };
        }

        // Release any expired holds on these seats (within the lock)
        await tx.query(`
          UPDATE seats
          SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
          WHERE id = ANY($1::int[])
            AND status = 'held'
            AND hold_expires_at <= NOW()
        `, [seatIds]);

        // Mark seats as held
        await tx.query(`
          UPDATE seats
          SET status = 'held', hold_id = $1, hold_expires_at = $2, session_id = $3
          WHERE id = ANY($4::int[])
        `, [holdId, expiresAt, sessionId, seatIds]);

        // Create hold record
        await tx.query(`
          INSERT INTO holds (id, session_id, seat_ids, expires_at, status)
          VALUES ($1, $2, $3, $4, 'active')
        `, [holdId, sessionId, seatIds, expiresAt]);

        // Fetch updated seats
        const updated = await tx.query(`
          SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
          FROM seats WHERE id = ANY($1::int[])
        `, [seatIds]);

        return {
          holdId,
          expiresAt,
          seats: updated.rows,
        };
      });
    } catch (txErr) {
      if (txErr.type === "conflict") {
        return res.status(409).json({
          error: "Some seats are unavailable",
          conflicting: txErr.conflicting,
        });
      }
      if (txErr.type === "not_found") {
        return res.status(404).json({
          error: "Some seat IDs not found",
          missing: txErr.missing,
        });
      }
      throw txErr;
    }

    // Broadcast
    broadcast("seatUpdate", result.seats);

    res.status(201).json({
      holdId: result.holdId,
      expiresAt: result.expiresAt,
      seats: result.seats,
    });
  } catch (err) {
    console.error("POST /api/holds error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/holds/:holdId/confirm — confirm a hold (idempotent)
app.post("/api/holds/:holdId/confirm", async (req, res) => {
  const { holdId } = req.params;

  try {
    const db = await getDb();

    // Expire stale holds first
    await expireStaleHolds(db);

    let result;
    try {
      result = await db.transaction(async (tx) => {
        // Look up the hold
        const holdResult = await tx.query(`
          SELECT id, session_id, seat_ids, expires_at, status
          FROM holds WHERE id = $1
          FOR UPDATE
        `, [holdId]);

        if (holdResult.rows.length === 0) {
          throw { type: "not_found" };
        }

        const hold = holdResult.rows[0];

        // Idempotent: if already confirmed, return the booked seats
        if (hold.status === "confirmed") {
          const bookedSeats = await tx.query(`
            SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
            FROM seats WHERE id = ANY($1::int[])
          `, [hold.seat_ids]);
          return { alreadyConfirmed: true, seats: bookedSeats.rows };
        }

        // If expired or released, reject
        if (hold.status === "expired" || hold.status === "released") {
          throw { type: "expired", reason: `Hold is ${hold.status}` };
        }

        // Check if expired by time
        if (new Date(hold.expires_at) <= new Date()) {
          // Mark as expired
          await tx.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [holdId]);
          // Release seats
          await tx.query(`
            UPDATE seats
            SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
            WHERE hold_id = $1 AND status = 'held'
          `, [holdId]);
          throw { type: "expired", reason: "Hold has expired" };
        }

        // Lock and verify the seats still belong to this hold
        const seatResult = await tx.query(`
          SELECT id, row_label, seat_number, status, hold_id
          FROM seats
          WHERE id = ANY($1::int[])
          ORDER BY id
          FOR UPDATE
        `, [hold.seat_ids]);

        // Verify every seat is still held by this hold
        for (const seat of seatResult.rows) {
          if (seat.status !== "held" || seat.hold_id !== holdId) {
            throw { type: "expired", reason: "Hold seats are no longer held by this hold" };
          }
        }

        // Book the seats
        await tx.query(`
          UPDATE seats
          SET status = 'booked', booked_by = $1, hold_expires_at = NULL
          WHERE hold_id = $2 AND status = 'held'
        `, [hold.session_id, holdId]);

        // Mark hold as confirmed
        await tx.query(`UPDATE holds SET status = 'confirmed' WHERE id = $1`, [holdId]);

        // Fetch updated seats
        const updated = await tx.query(`
          SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
          FROM seats WHERE id = ANY($1::int[])
        `, [hold.seat_ids]);

        return { alreadyConfirmed: false, seats: updated.rows };
      });
    } catch (txErr) {
      if (txErr.type === "not_found") {
        return res.status(404).json({ error: "Hold not found" });
      }
      if (txErr.type === "expired") {
        return res.status(410).json({ error: txErr.reason });
      }
      throw txErr;
    }

    // Broadcast seat updates (only if newly confirmed)
    if (!result.alreadyConfirmed) {
      broadcast("seatUpdate", result.seats);
    }

    res.json({
      holdId,
      status: "confirmed",
      seats: result.seats,
    });
  } catch (err) {
    console.error("POST /api/holds/:holdId/confirm error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/holds/:holdId — release a hold early
app.delete("/api/holds/:holdId", async (req, res) => {
  const { holdId } = req.params;

  try {
    const db = await getDb();

    let result;
    try {
      result = await db.transaction(async (tx) => {
        const holdResult = await tx.query(`
          SELECT id, session_id, seat_ids, status
          FROM holds WHERE id = $1
          FOR UPDATE
        `, [holdId]);

        if (holdResult.rows.length === 0) {
          throw { type: "not_found" };
        }

        const hold = holdResult.rows[0];

        // If already released/expired/confirmed, no-op
        if (hold.status !== "active") {
          // Fetch current seat state
          const seats = await tx.query(`
            SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
            FROM seats WHERE id = ANY($1::int[])
          `, [hold.seat_ids]);
          return { alreadyReleased: true, seats: seats.rows, previousStatus: hold.status };
        }

        // Release the seats
        await tx.query(`
          UPDATE seats
          SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
          WHERE hold_id = $1 AND status = 'held'
        `, [holdId]);

        // Mark hold as released
        await tx.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);

        const updated = await tx.query(`
          SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
          FROM seats WHERE id = ANY($1::int[])
        `, [hold.seat_ids]);

        return { alreadyReleased: false, seats: updated.rows };
      });
    } catch (txErr) {
      if (txErr.type === "not_found") {
        return res.status(404).json({ error: "Hold not found" });
      }
      throw txErr;
    }

    if (!result.alreadyReleased) {
      broadcast("seatUpdate", result.seats);
    }

    res.json({
      holdId,
      status: "released",
      seats: result.seats,
    });
  } catch (err) {
    console.error("DELETE /api/holds/:holdId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/stream — SSE endpoint
app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Send a ping immediately so the client knows the connection is alive
  res.write(`event: connected\ndata: {}\n\n`);

  addClient(res);

  // Keep-alive ping every 30s
  const pingInterval = setInterval(() => {
    try {
      res.write(`:ping\n\n`);
    } catch {
      clearInterval(pingInterval);
    }
  }, 30000);

  req.on("close", () => {
    clearInterval(pingInterval);
  });
});

// ────────────────────────────────────────────
// Periodic sweep for expired holds
// ────────────────────────────────────────────

let sweepInterval;

async function startSweep() {
  sweepInterval = setInterval(async () => {
    try {
      const db = await getDb();
      await expireStaleHolds(db);
    } catch (err) {
      console.error("Sweep error:", err);
    }
  }, 5000); // sweep every 5 seconds
}

// ────────────────────────────────────────────
// Start
// ────────────────────────────────────────────

async function start() {
  await initDb();
  console.log("Database initialized");

  startSweep();

  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
