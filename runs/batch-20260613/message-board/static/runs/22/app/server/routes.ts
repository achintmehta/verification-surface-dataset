import { Router } from "express";
import type { Request, Response } from "express";
import { getDB } from "./db.js";
import { addClient, broadcastMessage } from "./sse.js";
import type { Message, CreateMessageRequest } from "../shared/types.js";

export const router = Router();

/**
 * GET /api/messages
 *
 * Returns all historical messages ordered by creation time ascending.
 */
router.get("/messages", async (_req: Request, res: Response) => {
  try {
    const db = await getDB();
    const result = await db.query<Message>(
      "SELECT id, text, created_at FROM messages ORDER BY created_at ASC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("[routes] GET /api/messages error:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

/**
 * POST /api/messages
 *
 * Creates a new message and broadcasts it to all SSE clients.
 * Expects JSON body: { "text": "…" }
 */
router.post("/messages", async (req: Request, res: Response) => {
  try {
    const { text } = req.body as CreateMessageRequest;

    if (!text || typeof text !== "string" || text.trim().length === 0) {
      res.status(400).json({ error: "\"text\" field is required and must be a non-empty string" });
      return;
    }

    const sanitizedText = text.trim();
    const db = await getDB();
    const result = await db.query<Message>(
      "INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at",
      [sanitizedText]
    );

    const newMessage = result.rows[0];
    if (!newMessage) {
      res.status(500).json({ error: "Insert succeeded but no row was returned" });
      return;
    }

    // Broadcast to all connected SSE clients
    broadcastMessage(newMessage);

    res.status(201).json(newMessage);
  } catch (err) {
    console.error("[routes] POST /api/messages error:", err);
    res.status(500).json({ error: "Failed to create message" });
  }
});

/**
 * GET /api/stream
 *
 * Opens an SSE connection for real-time message updates.
 */
router.get("/stream", (_req: Request, res: Response) => {
  // Disable any request timeout for long-lived SSE connections
  _req.socket.setTimeout(0);

  addClient(res);
});
