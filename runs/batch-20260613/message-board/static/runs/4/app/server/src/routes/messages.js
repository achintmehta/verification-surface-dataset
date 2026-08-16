/**
 * routes/messages.js – Express router for the /api/messages endpoints.
 *
 * GET  /api/messages        – Return all messages ordered oldest-first.
 * POST /api/messages        – Insert a new message and broadcast it via SSE.
 */

import { Router } from "express";
import { getDb } from "../db.js";
import { broadcast } from "../sse.js";

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/messages
// ---------------------------------------------------------------------------
router.get("/", async (_req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(
      "SELECT id, text, created_at FROM messages ORDER BY created_at ASC, id ASC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("[messages] GET error:", err);
    res.status(500).json({ error: "Failed to fetch messages." });
  }
});

// ---------------------------------------------------------------------------
// POST /api/messages
// ---------------------------------------------------------------------------
router.post("/", async (req, res) => {
  const text = (req.body?.text ?? "").trim();

  if (!text) {
    return res.status(400).json({ error: "Message text is required." });
  }

  if (text.length > 2000) {
    return res
      .status(400)
      .json({ error: "Message text must be 2000 characters or fewer." });
  }

  try {
    const db = await getDb();
    const result = await db.query(
      "INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at",
      [text]
    );

    const message = result.rows[0];

    // Push the new message to all connected SSE clients.
    broadcast(message);

    res.status(201).json(message);
  } catch (err) {
    console.error("[messages] POST error:", err);
    res.status(500).json({ error: "Failed to save message." });
  }
});

export default router;
