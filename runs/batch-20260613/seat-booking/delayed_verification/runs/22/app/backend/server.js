import express from "express";
import cors from "cors";
import { getDb, closeDb } from "./db.js";
import { addClient } from "./sse.js";
import {
  initSeatsModule,
  getAllSeats,
  createHold,
  confirmHold,
  releaseHold,
  getInventory,
} from "./seats.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Initialize database and seats module
let dbReady = false;

async function init() {
  const db = await getDb();
  initSeatsModule(db);
  dbReady = true;
  console.log("Database initialized");
}

// Middleware to ensure database is ready
app.use((req, res, next) => {
  if (!dbReady) {
    return res.status(503).json({ error: "Server initializing, please retry" });
  }
  next();
});

// ==================== SSE Endpoint ====================

app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Send a connected event
  res.write(`event: connected\ndata: ${JSON.stringify({ message: "Connected to seat booking stream" })}\n\n`);

  addClient(res);

  // Keep-alive ping every 15s
  const keepAlive = setInterval(() => {
    try {
      res.write(`: keep-alive\n\n`);
    } catch {
      clearInterval(keepAlive);
    }
  }, 15000);

  req.on("close", () => {
    clearInterval(keepAlive);
  });
});

// ==================== REST Endpoints ====================

// GET /api/seats - Get all seats with effective status
app.get("/api/seats", async (req, res) => {
  try {
    const seats = await getAllSeats();
    res.json({ seats });
  } catch (err) {
    console.error("Error getting seats:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/inventory - Get inventory counts
app.get("/api/inventory", async (req, res) => {
  try {
    const inventory = await getInventory();
    res.json(inventory);
  } catch (err) {
    console.error("Error getting inventory:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/holds - Create a hold on one or more seats
app.post("/api/holds", async (req, res) => {
  try {
    const { seatIds, sessionId } = req.body;

    if (!Array.isArray(seatIds) || seatIds.length === 0) {
      return res.status(400).json({ error: "seatIds must be a non-empty array" });
    }
    if (!sessionId || typeof sessionId !== "string") {
      return res.status(400).json({ error: "sessionId is required and must be a string" });
    }

    // Validate seatIds are integers
    const parsedSeatIds = seatIds.map((id) => parseInt(id, 10));
    if (parsedSeatIds.some(isNaN)) {
      return res.status(400).json({ error: "All seatIds must be valid integers" });
    }

    const hold = await createHold(parsedSeatIds, sessionId);
    res.status(201).json({ hold });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        error: err.message,
        conflictingSeats: err.conflictingSeats,
        missingIds: err.missingIds,
      });
    }
    console.error("Error creating hold:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/holds/:holdId/confirm - Confirm a hold (book the seats)
app.post("/api/holds/:holdId/confirm", async (req, res) => {
  try {
    const { holdId } = req.params;
    const result = await confirmHold(holdId);
    res.json({
      message: result.idempotent
        ? "Hold was already confirmed"
        : "Hold confirmed, seats booked",
      hold: result.hold,
      seats: result.seats,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error("Error confirming hold:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/holds/:holdId - Release a hold
app.delete("/api/holds/:holdId", async (req, res) => {
  try {
    const { holdId } = req.params;
    const result = await releaseHold(holdId);
    res.json({ message: result.message, seats: result.seats });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error("Error releasing hold:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Start server
init()
  .then(() => {
    const server = app.listen(PORT, () => {
      console.log(`Seat booking server running on http://localhost:${PORT}`);
    });

    // Graceful shutdown: close PGlite cleanly so the persisted pgdata directory
    // is flushed and not corrupted (a hard kill can leave it un-openable).
    let shuttingDown = false;
    const shutdown = async (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\nReceived ${signal}, shutting down...`);
      server.close();
      try {
        await closeDb();
        console.log("Database closed cleanly");
      } catch (err) {
        console.error("Error closing database:", err);
      }
      process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  })
  .catch((err) => {
    console.error("Failed to initialize:", err);
    process.exit(1);
  });

export default app;
