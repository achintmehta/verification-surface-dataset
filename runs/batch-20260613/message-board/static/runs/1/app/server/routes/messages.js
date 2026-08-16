/**
 * routes/messages.js
 * Express router handling:
 *   GET  /api/messages  — fetch all historical messages (newest last)
 *   POST /api/messages  — insert a new message and broadcast it via SSE
 */

import { Router } from 'express';
import db from '../db.js';
import { broadcast } from '../sseClients.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/messages
// Returns all messages ordered chronologically (oldest first).
// ---------------------------------------------------------------------------
router.get('/', async (_req, res) => {
  try {
    const result = await db.query(
      'SELECT id, text, created_at FROM messages ORDER BY created_at ASC, id ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /api/messages]', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/messages
// Body: { text: string }
// Inserts the message, then broadcasts it to all SSE clients.
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const text = (req.body?.text ?? '').trim();

  if (!text) {
    return res.status(400).json({ error: 'text is required and must not be empty' });
  }

  if (text.length > 2000) {
    return res.status(400).json({ error: 'text must be 2000 characters or fewer' });
  }

  try {
    const result = await db.query(
      'INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at',
      [text]
    );
    const message = result.rows[0];

    // Push the new message to every connected SSE client.
    broadcast('new-message', message);

    res.status(201).json(message);
  } catch (err) {
    console.error('[POST /api/messages]', err);
    res.status(500).json({ error: 'Failed to save message' });
  }
});

export default router;
