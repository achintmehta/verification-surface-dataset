import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { initDb, getMessages, insertMessage } from "./db.js";
import { addClient, broadcast } from "./sse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

/**
 * GET /api/messages
 * Returns the full message history so clients can render the initial state.
 */
app.get("/api/messages", async (_req, res) => {
  try {
    const messages = await getMessages();
    res.json(messages);
  } catch (err) {
    console.error("[api] failed to fetch messages:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

/**
 * POST /api/messages
 * Inserts a new message, then broadcasts it to all connected SSE clients.
 * Body: { text: string }
 */
app.post("/api/messages", async (req, res) => {
  const { text } = req.body ?? {};

  if (typeof text !== "string" || text.trim().length === 0) {
    return res.status(400).json({ error: "`text` is required" });
  }

  try {
    const message = await insertMessage(text.trim());
    broadcast("message", message);
    res.status(201).json(message);
  } catch (err) {
    console.error("[api] failed to insert message:", err);
    res.status(500).json({ error: "Failed to create message" });
  }
});

/**
 * GET /api/stream
 * Server-Sent Events endpoint. Each client maintains one long-lived
 * connection here to receive new messages in real time.
 */
app.get("/api/stream", (req, res) => {
  addClient(req, res);
});

// In production, serve the built frontend (if present).
const clientDist = path.resolve(__dirname, "..", "..", "client", "dist");
app.use(express.static(clientDist));

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("[server] fatal startup error:", err);
  process.exit(1);
});
