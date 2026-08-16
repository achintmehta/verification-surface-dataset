const express = require("express");
const cors = require("cors");
const path = require("path");
const { initDb } = require("./db");
const { getAllSeats, expireHolds } = require("./seats");
const { createHold, confirmHold, releaseHold } = require("./holds");
const { addClient, broadcast, clientCount } = require("./sse");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static frontend files in production
app.use(express.static(path.join(__dirname, "..", "frontend", "dist")));

// ─── SSE Endpoint ──────────────────────────────────────────────────
app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Send initial heartbeat
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

  addClient(res);

  // Heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(`data: ${JSON.stringify({ type: "heartbeat" })}\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
  });
});

// ─── GET /api/seats ────────────────────────────────────────────────
app.get("/api/seats", async (req, res) => {
  try {
    const seats = await getAllSeats();
    res.json({ seats });
  } catch (err) {
    console.error("Error fetching seats:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /api/holds ───────────────────────────────────────────────
app.post("/api/holds", async (req, res) => {
  try {
    const { seatIds, sessionId } = req.body;
    const result = await createHold(seatIds, sessionId);
    res.status(201).json(result);
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({
        error: "Seats unavailable",
        conflicting: err.conflicting,
      });
    }
    if (err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Error creating hold:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /api/holds/:holdId/confirm ──────────────────────────────
app.post("/api/holds/:holdId/confirm", async (req, res) => {
  try {
    const { holdId } = req.params;
    const result = await confirmHold(holdId);
    res.json(result);
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: err.message });
    }
    if (err.status === 410) {
      return res.status(410).json({ error: err.message });
    }
    if (err.status === 409) {
      return res.status(409).json({ error: err.message });
    }
    console.error("Error confirming hold:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── DELETE /api/holds/:holdId ─────────────────────────────────────
app.delete("/api/holds/:holdId", async (req, res) => {
  try {
    const { holdId } = req.params;
    const result = await releaseHold(holdId);
    res.json(result);
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: err.message });
    }
    if (err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Error releasing hold:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /api/inventory ────────────────────────────────────────────
app.get("/api/inventory", async (req, res) => {
  try {
    const seats = await getAllSeats();
    const available = seats.filter((s) => s.status === "available").length;
    const held = seats.filter((s) => s.status === "held").length;
    const booked = seats.filter((s) => s.status === "booked").length;
    const total = seats.length;
    res.json({ available, held, booked, total, balanced: available + held + booked === total });
  } catch (err) {
    console.error("Error fetching inventory:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Start server ──────────────────────────────────────────────────
async function start() {
  try {
    await initDb();
    console.log("Database initialized");

    // Periodic sweep for expired holds (every 5 seconds)
    setInterval(async () => {
      try {
        await expireHolds();
      } catch (err) {
        console.error("Error in expiry sweep:", err);
      }
    }, 5000);

    app.listen(PORT, () => {
      console.log(`Seat booking server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

start();
