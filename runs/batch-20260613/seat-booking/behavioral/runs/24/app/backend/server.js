import express from "express";
import cors from "cors";
import { initDb } from "./db.js";
import { addClient } from "./sse.js";
import {
  getAllSeats,
  createHold,
  confirmHold,
  releaseHold,
  getInventory,
  sweepExpiredHolds,
} from "./seats.js";

const app = express();
app.use(cors());
app.use(express.json());

// ---- SSE endpoint ----
app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // Send initial ping
  res.write("event: connected\ndata: {}\n\n");
  addClient(res);
  // Keep-alive heartbeat every 30s
  const interval = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 30000);
  req.on("close", () => clearInterval(interval));
});

// ---- Seats ----
app.get("/api/seats", async (_req, res) => {
  try {
    const seats = await getAllSeats();
    res.json(seats);
  } catch (err) {
    console.error("GET /api/seats error:", err);
    res.status(500).json({ error: "internal", message: err.message });
  }
});

// ---- Inventory ----
app.get("/api/inventory", async (_req, res) => {
  try {
    const inv = await getInventory();
    res.json(inv);
  } catch (err) {
    console.error("GET /api/inventory error:", err);
    res.status(500).json({ error: "internal", message: err.message });
  }
});

// ---- Holds ----
app.post("/api/holds", async (req, res) => {
  try {
    const { seatIds, sessionId } = req.body;
    if (!Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
      return res.status(400).json({ error: "bad_request", message: "seatIds (non-empty array) and sessionId are required" });
    }
    const result = await createHold(seatIds, sessionId);
    if (result.error === "conflict") {
      return res.status(409).json(result);
    }
    if (result.error === "not_found") {
      return res.status(404).json(result);
    }
    if (result.error) {
      return res.status(400).json(result);
    }
    res.status(201).json(result);
  } catch (err) {
    console.error("POST /api/holds error:", err);
    res.status(500).json({ error: "internal", message: err.message });
  }
});

// ---- Confirm ----
app.post("/api/holds/:holdId/confirm", async (req, res) => {
  try {
    const { holdId } = req.params;
    const result = await confirmHold(holdId);
    if (result.error === "not_found") {
      return res.status(404).json(result);
    }
    if (result.error === "expired") {
      return res.status(410).json(result);
    }
    if (result.error) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    console.error("POST /api/holds/:holdId/confirm error:", err);
    res.status(500).json({ error: "internal", message: err.message });
  }
});

// ---- Release ----
app.delete("/api/holds/:holdId", async (req, res) => {
  try {
    const { holdId } = req.params;
    const result = await releaseHold(holdId);
    if (result.error === "not_found") {
      return res.status(404).json(result);
    }
    if (result.error) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    console.error("DELETE /api/holds/:holdId error:", err);
    res.status(500).json({ error: "internal", message: err.message });
  }
});

// ---- Start ----
const PORT = process.env.PORT || 3000;

let server;

export async function startServer(port) {
  const pg = await initDb();
  const listenPort = port || PORT;
  return new Promise((resolve) => {
    server = app.listen(listenPort, () => {
      console.log(`Seat-booking server listening on port ${listenPort}`);
      resolve(server);
    });
  });
}

export { app };

// Periodic sweep every 5 seconds
let sweepInterval;
function startSweep() {
  sweepInterval = setInterval(async () => {
    try {
      await sweepExpiredHolds();
    } catch (e) {
      console.error("Sweep error:", e);
    }
  }, 5000);
}

// If this file is the main entry point, start the server
const isMain = process.argv[1] && (
  process.argv[1].endsWith("server.js") ||
  process.argv[1].endsWith("server")
);

if (isMain) {
  startServer().then(() => {
    startSweep();
  });
}
