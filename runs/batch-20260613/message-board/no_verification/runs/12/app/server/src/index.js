import express from "express";
import cors from "cors";
import { initDb, getDb } from "./db.js";
import { addClient, broadcast } from "./sse.js";

const PORT = process.env.PORT || 3001;

async function main() {
  await initDb();

  const app = express();
  app.use(cors());
  app.use(express.json());

  /**
   * GET /api/messages
   * Returns the full message history (oldest first) so a freshly loaded client
   * can render the initial state of the board.
   */
  app.get("/api/messages", async (_req, res) => {
    try {
      const db = getDb();
      const result = await db.query(
        "SELECT id, text, created_at FROM messages ORDER BY created_at ASC, id ASC"
      );
      res.json(result.rows);
    } catch (err) {
      console.error("[api] failed to fetch messages:", err);
      res.status(500).json({ error: "Failed to fetch messages" });
    }
  });

  /**
   * POST /api/messages
   * Inserts a new text message, then broadcasts it to every connected SSE
   * client so all boards update in real time.
   */
  app.post("/api/messages", async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";

    if (!text) {
      return res.status(400).json({ error: "Message text is required" });
    }
    if (text.length > 2000) {
      return res.status(400).json({ error: "Message is too long (max 2000 characters)" });
    }

    try {
      const db = getDb();
      const result = await db.query(
        "INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at",
        [text]
      );
      const message = result.rows[0];

      // Push the new message to every connected client.
      broadcast("message", message);

      res.status(201).json(message);
    } catch (err) {
      console.error("[api] failed to insert message:", err);
      res.status(500).json({ error: "Failed to save message" });
    }
  });

  /**
   * GET /api/stream
   * Server-Sent Events endpoint. The connection stays open and receives a
   * `message` event whenever someone posts to the board.
   */
  app.get("/api/stream", (req, res) => {
    addClient(req, res);
  });

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("[server] fatal error during startup:", err);
  process.exit(1);
});
