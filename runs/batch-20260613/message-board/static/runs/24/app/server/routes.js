import { Router } from "express";
import { getDb } from "./db.js";
import { addClient, broadcast } from "./sse.js";

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/messages – Return all historical messages ordered by creation time.
// ---------------------------------------------------------------------------
router.get("/messages", async (_req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(
      "SELECT id, text, created_at FROM messages ORDER BY created_at ASC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Failed to fetch messages:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/messages – Insert a new message and broadcast it to SSE clients.
// ---------------------------------------------------------------------------
router.post("/messages", async (req, res) => {
  const { text } = req.body;

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    res.status(400).json({ error: "Message text is required" });
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
    console.error("Failed to insert message:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/stream – SSE endpoint for real-time updates.
// ---------------------------------------------------------------------------
router.get("/stream", (req, res) => {
  addClient(res);

  // Keep-alive: send a comment every 30s to prevent proxy / browser timeouts.
  const keepAlive = setInterval(() => {
    res.write(":keep-alive\n\n");
  }, 30_000);

  req.on("close", () => {
    clearInterval(keepAlive);
  });
});

export default router;
