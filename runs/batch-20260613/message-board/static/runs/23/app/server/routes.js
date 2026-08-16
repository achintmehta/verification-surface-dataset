import { Router } from "express";
import { getDb } from "./db.js";
import { addClient, removeClient, broadcast } from "./sse.js";

const router = Router();

// ────────────────────────────────────────────────────────────────────────────
// GET /api/messages – Return all historical messages ordered by creation time.
// ────────────────────────────────────────────────────────────────────────────
router.get("/api/messages", async (_req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(
      "SELECT id, text, created_at FROM messages ORDER BY created_at ASC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/messages error:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/messages – Insert a new message and broadcast it to SSE clients.
// ────────────────────────────────────────────────────────────────────────────
router.post("/api/messages", async (req, res) => {
  const { text } = req.body ?? {};

  if (typeof text !== "string" || text.trim().length === 0) {
    res.status(400).json({ error: "\"text\" is required and must be a non-empty string." });
    return;
  }

  try {
    const db = await getDb();
    const result = await db.query(
      "INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at",
      [text.trim()]
    );

    const message = result.rows[0];

    // Push the new message to every connected SSE client.
    broadcast("new-message", message);

    res.status(201).json(message);
  } catch (err) {
    console.error("POST /api/messages error:", err);
    res.status(500).json({ error: "Failed to create message" });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/stream – SSE endpoint. Keeps the connection open for real-time
// push notifications.
// ────────────────────────────────────────────────────────────────────────────
router.get("/api/stream", (req, res) => {
  addClient(res);

  // Clean up when the client disconnects.
  req.on("close", () => {
    removeClient(res);
  });
});

export default router;
