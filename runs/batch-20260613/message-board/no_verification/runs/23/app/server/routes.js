import { Router } from "express";
import { getMessages, insertMessage } from "./db.js";
import { addClient, broadcast } from "./sse.js";

const router = Router();

/**
 * GET /api/messages
 * Returns all historical messages sorted by created_at ASC.
 */
router.get("/messages", async (_req, res, next) => {
  try {
    const messages = await getMessages();
    res.json(messages);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/messages
 * Creates a new message.  Body: { text: string }
 * On success the new message is broadcast to all SSE clients.
 */
router.post("/messages", async (req, res, next) => {
  try {
    const { text } = req.body;

    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return res.status(400).json({ error: "text is required and must be a non-empty string" });
    }

    const message = await insertMessage(text.trim());
    broadcast(message);
    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/stream
 * SSE endpoint – keeps the connection open and pushes new messages as they arrive.
 */
router.get("/stream", (req, res) => {
  addClient(req, res);
});

export default router;
