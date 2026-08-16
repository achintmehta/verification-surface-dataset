import { Router } from "express";
import { getDb } from "./db.js";
import { addClient, broadcast } from "./sse.js";

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/messages – return all historical messages (oldest first)
// ---------------------------------------------------------------------------
router.get("/messages", async (_req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(
      "SELECT id, text, created_at FROM messages ORDER BY created_at ASC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("[routes] GET /api/messages error:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/messages – insert a new message and broadcast via SSE
// ---------------------------------------------------------------------------
router.post("/messages", async (req, res) => {
  const { text } = req.body;

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return res.status(400).json({ error: "Message text is required" });
  }

  try {
    const db = await getDb();
    const result = await db.query(
      "INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at",
      [text.trim()]
    );

    const newMessage = result.rows[0];

    // Broadcast to every SSE client
    broadcast(newMessage);

    res.status(201).json(newMessage);
  } catch (err) {
    console.error("[routes] POST /api/messages error:", err);
    res.status(500).json({ error: "Failed to create message" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/stream – SSE endpoint for real-time updates
// ---------------------------------------------------------------------------
router.get("/stream", (req, res) => {
  addClient(req, res);
});

export default router;
