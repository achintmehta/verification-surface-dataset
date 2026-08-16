import { Router } from "express";
import type { Request, Response } from "express";
import { getDb } from "../db.js";
import type { MessageRow } from "../db.js";
import { broadcast } from "../sse.js";

const router = Router();

/**
 * GET /api/messages
 *
 * Returns the most recent 100 messages ordered chronologically
 * (oldest first) so the client can render them in a natural top-to-bottom order.
 */
router.get("/", async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const result = await db.query<MessageRow>(
      "SELECT id, text, created_at FROM messages ORDER BY created_at ASC LIMIT 100"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Failed to fetch messages:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

/**
 * POST /api/messages
 *
 * Creates a new message. Expects a JSON body with a `text` field.
 * After inserting, the new message is broadcast to all SSE clients.
 */
router.post("/", async (req: Request, res: Response) => {
  const { text } = req.body as { text?: string };

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    res.status(400).json({ error: "Message text is required" });
    return;
  }

  try {
    const db = await getDb();
    const result = await db.query<MessageRow>(
      "INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at",
      [text.trim()]
    );

    const newMessage = result.rows[0];
    broadcast(newMessage);
    res.status(201).json(newMessage);
  } catch (err) {
    console.error("Failed to create message:", err);
    res.status(500).json({ error: "Failed to create message" });
  }
});

export default router;
