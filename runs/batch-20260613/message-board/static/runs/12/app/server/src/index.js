import express from "express";
import cors from "cors";
import { getDb, initDb } from "./db.js";
import { sseBroker } from "./sse.js";

const PORT = Number(process.env.PORT) || 3001;

const app = express();
app.use(cors());
app.use(express.json());

/**
 * GET /api/messages
 * Fetch the historical messages (oldest first) so clients can render
 * the initial state of the board.
 */
app.get("/api/messages", async (_req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(
      "SELECT id, text, created_at FROM messages ORDER BY created_at ASC, id ASC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Failed to fetch messages:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

/**
 * POST /api/messages
 * Insert a new text message into PGLite and broadcast it to all
 * connected SSE clients.
 */
app.post("/api/messages", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";

  if (!text) {
    return res.status(400).json({ error: "Message text is required" });
  }

  try {
    const db = await getDb();
    const result = await db.query(
      "INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at",
      [text]
    );
    const message = result.rows[0];

    // Push the new message to every active SSE connection.
    sseBroker.broadcast("message", message);

    res.status(201).json(message);
  } catch (err) {
    console.error("Failed to insert message:", err);
    res.status(500).json({ error: "Failed to insert message" });
  }
});

/**
 * GET /api/stream
 * Open a long-lived Server-Sent Events connection. New messages are
 * pushed to the client as `message` events.
 */
app.get("/api/stream", (req, res) => {
  sseBroker.addClient(req, res);
});

/**
 * Simple health check.
 */
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, connections: sseBroker.connectionCount });
});

async function start() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`Server listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

start();
