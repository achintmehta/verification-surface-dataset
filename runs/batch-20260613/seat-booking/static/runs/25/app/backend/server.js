import express from "express";
import cors from "cors";
import { getDb } from "./db.js";
import { addClient } from "./sse.js";
import {
  getAllSeats,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpiredHolds,
} from "./seats.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ──────────────────────────────
// GET /api/seats - return all seats with effective status
// ──────────────────────────────
app.get("/api/seats", async (_req, res) => {
  try {
    const seats = await getAllSeats();
    res.json({ seats });
  } catch (err) {
    console.error("GET /api/seats error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────
// POST /api/holds - create a hold on seats
// Body: { seatIds: number[], sessionId: string }
// ──────────────────────────────
app.post("/api/holds", async (req, res) => {
  try {
    const { seatIds, sessionId } = req.body;

    if (!Array.isArray(seatIds) || seatIds.length === 0) {
      res.status(400).json({ error: "seatIds must be a non-empty array" });
      return;
    }
    if (!sessionId || typeof sessionId !== "string") {
      res.status(400).json({ error: "sessionId is required" });
      return;
    }

    // Ensure seatIds are integers
    const parsedSeatIds = seatIds.map((id) => {
      const parsed = Number(id);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid seat id: ${id}`);
      }
      return parsed;
    });

    // Deduplicate
    const uniqueSeatIds = [...new Set(parsedSeatIds)];

    const result = await createHold(uniqueSeatIds, sessionId);

    if (result.success) {
      res.status(201).json(result);
    } else {
      res.status(409).json(result);
    }
  } catch (err) {
    console.error("POST /api/holds error:", err);
    if (err instanceof Error && err.message.startsWith("Invalid seat id")) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────
// POST /api/holds/:holdId/confirm - confirm a hold
// Body: { sessionId: string }
// ──────────────────────────────
app.post("/api/holds/:holdId/confirm", async (req, res) => {
  try {
    const { holdId } = req.params;
    const { sessionId } = req.body;

    if (!sessionId || typeof sessionId !== "string") {
      res.status(400).json({ error: "sessionId is required" });
      return;
    }

    const result = await confirmHold(holdId, sessionId);

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(result.statusCode).json({ error: result.reason });
    }
  } catch (err) {
    console.error("POST /api/holds/:holdId/confirm error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────
// DELETE /api/holds/:holdId - release a hold early
// Body or query: { sessionId: string }
// ──────────────────────────────
app.delete("/api/holds/:holdId", async (req, res) => {
  try {
    const { holdId } = req.params;
    // Accept sessionId from body or query
    const sessionId = req.body?.sessionId || req.query?.sessionId;

    if (!sessionId || typeof sessionId !== "string") {
      res.status(400).json({ error: "sessionId is required" });
      return;
    }

    const result = await releaseHold(holdId, sessionId);

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(result.statusCode).json({ error: result.reason });
    }
  } catch (err) {
    console.error("DELETE /api/holds/:holdId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────
// GET /api/stream - SSE endpoint
// ──────────────────────────────
app.get("/api/stream", (req, res) => {
  addClient(req, res);
});

// ──────────────────────────────
// Start server
// ──────────────────────────────
async function start() {
  // Initialize DB
  await getDb();
  console.log("Database initialized");

  // Start periodic sweep every 5 seconds
  setInterval(sweepExpiredHolds, 5000);

  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

export default app;
