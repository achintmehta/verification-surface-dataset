/**
 * routes/messages.js
 * Express router handling:
 *   GET  /api/messages  – return all messages ordered by created_at ASC
 *   POST /api/messages  – insert a new message and broadcast it via SSE
 */

import { Router } from 'express';
import db from '../db.js';
import { broadcast } from '../sseClients.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/messages
// Returns the full message history, oldest first.
// ---------------------------------------------------------------------------
router.get('/', async (_req, res) => {
  try {
    const result = await db.query(
      'SELECT id, text, created_at FROM messages ORDER BY created_at ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[messages] GET error:', err);
    res.status(500).json({ error: 'Failed to fetch messages.' });
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
    return res.status(400).json({ error: 'Message text must not be empty.' });
  }

  if (text.length > 2000) {
    return res
      .status(400)
      .json({ error: 'Message text must be 2 000 characters or fewer.' });
  }

  try {
    const result = await db.query(
      'INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at',
      [text]
    );

    const message = result.rows[0];

    // Push the new message to every connected SSE client immediately.
    broadcast('message', message);

    res.status(201).json(message);
  } catch (err) {
    console.error('[messages] POST error:', err);
    res.status(500).json({ error: 'Failed to save message.' });
  }
});

export default router;
