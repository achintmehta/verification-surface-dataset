import express from "express";
import cors from "cors";
import { PGlite } from "@electric-sql/pglite";

// ---------------------------------------------------------------------------
// 1. PGLite Database Setup
// ---------------------------------------------------------------------------
const db = new PGlite("./pgdata"); // persist to local filesystem

async function initDb() {
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
// 2. Express Server
// ---------------------------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// 3. SSE – maintain a set of active response objects
// ---------------------------------------------------------------------------
/** @type {Set<import('express').Response>} */
const sseClients = new Set();

/**
 * GET /api/stream
 * Opens a long‑lived SSE connection. The server sends a `message` event for
 * every new post that is created after the connection is established.
 */
app.get("/api/stream", (_req, res) => {
  // Standard SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send an initial comment so the client knows the connection is alive
  res.write(": connected\n\n");

  sseClients.add(res);

  // Clean up when the client disconnects
  _req.on("close", () => {
    sseClients.delete(res);
  });
});

/**
 * Broadcast a message object to every connected SSE client.
 * @param {object} message
 */
function broadcast(message) {
  const payload = `data: ${JSON.stringify(message)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

// ---------------------------------------------------------------------------
// 4. REST API
// ---------------------------------------------------------------------------

/**
 * GET /api/messages
 * Returns all messages ordered by creation time (ascending).
 */
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

/**
 * POST /api/messages
 * Inserts a new message and broadcasts it to all SSE clients.
 * Body: { "text": "Hello world" }
 */
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

    const newMessage = result.rows[0];

    // Broadcast to all connected SSE clients
    broadcast(newMessage);

    res.status(201).json(newMessage);
  } catch (err) {
    console.error("[POST /api/messages]", err);
    res.status(500).json({ error: "Failed to create message" });
  }
});

// ---------------------------------------------------------------------------
// 5. Start
// ---------------------------------------------------------------------------
await initDb();

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
