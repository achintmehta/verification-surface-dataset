import express from "express";
import cors from "cors";
import { PGlite } from "@electric-sql/pglite";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "pgdata");

// ---------------------------------------------------------------------------
// Database – Embedded PGLite persisted to disk
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
// SSE – Client connection management
// ---------------------------------------------------------------------------

/** @type {Set<import("express").Response>} */
const sseClients = new Set();

/**
 * Broadcast a server-sent event to every connected client.
 * @param {string} event  – the event name
 * @param {unknown} data  – JSON-serialisable payload
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

// Serve the built frontend in production (client/dist)
const clientDist = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientDist));

// ---- GET /api/messages – fetch historical messages ----
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

// ---- POST /api/messages – create a new message ----
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
    broadcast("new_message", message);

    res.status(201).json(message);
  } catch (err) {
    console.error("[POST /api/messages]", err);
    res.status(500).json({ error: "Failed to create message" });
  }
});

// ---- GET /api/stream – SSE endpoint ----
app.get("/api/stream", (req, res) => {
  // Set headers for SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send an initial comment to flush headers / confirm connection
  res.write(":connected\n\n");

  // Register this client
  sseClients.add(res);
  console.log(`[sse] client connected  (total: ${sseClients.size})`);

  // Clean up on disconnect
  req.on("close", () => {
    sseClients.delete(res);
    console.log(`[sse] client disconnected (total: ${sseClients.size})`);
  });
});

// Fallback: serve index.html for SPA routing (production)
app.get("*", (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
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
  console.error("Failed to start server:", err);
  process.exit(1);
});
