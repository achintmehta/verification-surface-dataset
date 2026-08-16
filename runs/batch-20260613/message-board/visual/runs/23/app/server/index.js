import express from "express";
import cors from "cors";
import { PGlite } from "@electric-sql/pglite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3001;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "pgdata");

// ---------------------------------------------------------------------------
// Database Setup (PGLite – embedded PostgreSQL)
// ---------------------------------------------------------------------------
const db = new PGlite(DB_PATH);

async function initDatabase() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      text       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log("[db] messages table ready");
}

// ---------------------------------------------------------------------------
// SSE client management
// ---------------------------------------------------------------------------
/** @type {Set<import('express').Response>} */
const sseClients = new Set();

/**
 * Broadcast a JSON payload to every connected SSE client.
 * @param {string} event  – SSE event name
 * @param {object} data   – payload (will be JSON-stringified)
 */
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

// ---------------------------------------------------------------------------
// Express App
// ---------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

// ---- GET /api/messages – historical messages (oldest first) ---------------
app.get("/api/messages", async (_req, res) => {
  try {
    const result = await db.query(
      "SELECT id, text, created_at FROM messages ORDER BY created_at ASC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("[GET /api/messages]", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// ---- POST /api/messages – create a new message ---------------------------
app.post("/api/messages", async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return res.status(400).json({ error: "text is required" });
  }

  try {
    const result = await db.query(
      "INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at",
      [text.trim()]
    );
    const message = result.rows[0];

    // Broadcast the new message to all SSE clients
    broadcast("new-message", message);

    res.status(201).json(message);
  } catch (err) {
    console.error("[POST /api/messages]", err);
    res.status(500).json({ error: "Failed to create message" });
  }
});

// ---- GET /api/stream – SSE endpoint --------------------------------------
app.get("/api/stream", (req, res) => {
  // Set headers for SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disable nginx buffering if proxied
  });

  // Send an initial comment so the client knows the connection is alive
  res.write(": connected\n\n");

  // Register client
  sseClients.add(res);
  console.log(`[sse] client connected  (total: ${sseClients.size})`);

  // Remove client on disconnect
  req.on("close", () => {
    sseClients.delete(res);
    console.log(`[sse] client disconnected (total: ${sseClients.size})`);
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
  await initDatabase();
  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error", err);
  process.exit(1);
});
