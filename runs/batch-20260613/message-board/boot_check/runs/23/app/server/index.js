import express from "express";
import cors from "cors";
import { PGlite } from "@electric-sql/pglite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "pgdata");

// ---------------------------------------------------------------------------
// Database – Embedded PGLite persisted to disk
// ---------------------------------------------------------------------------
const db = new PGlite(DB_PATH);

async function initDB() {
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
// SSE – Active client connections
// ---------------------------------------------------------------------------
/** @type {Set<import('express').Response>} */
const sseClients = new Set();

/**
 * Broadcast a message object to every connected SSE client.
 * @param {object} message
 */
function broadcast(message) {
  const payload = `data: ${JSON.stringify(message)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

// ---------------------------------------------------------------------------
// Express application
// ---------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

// --- GET /api/messages – Return full message history (oldest first) --------
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

// --- POST /api/messages – Insert a new message and broadcast ---------------
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

    // Broadcast to all SSE clients
    broadcast(message);

    res.status(201).json(message);
  } catch (err) {
    console.error("[POST /api/messages]", err);
    res.status(500).json({ error: "Failed to create message" });
  }
});

// --- GET /api/stream – SSE endpoint ----------------------------------------
app.get("/api/stream", (req, res) => {
  // Set SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send an initial comment so the client knows the connection is alive
  res.write(":connected\n\n");

  sseClients.add(res);
  console.log(`[sse] client connected  (total: ${sseClients.size})`);

  // Clean up on disconnect
  req.on("close", () => {
    sseClients.delete(res);
    console.log(`[sse] client disconnected (total: ${sseClients.size})`);
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
  await initDB();

  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error", err);
  process.exit(1);
});
