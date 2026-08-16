/**
 * routes/messages.js
 * Express router that handles:
 *   GET  /api/messages  – return all messages ordered oldest-first
 *   POST /api/messages  – insert a new message and broadcast it via SSE
 */

import { Router } from 'express';
import { getDb } from '../db.js';
import { broadcast } from '../sseManager.js';

const router = Router();

/* ------------------------------------------------------------------ */
/* GET /api/messages                                                    */
/* Returns the full message history, oldest message first.             */
/* ------------------------------------------------------------------ */
router.get('/', async (_req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(
      'SELECT id, text, created_at FROM messages ORDER BY created_at ASC, id ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /api/messages]', err);
    res.status(500).json({ error: 'Failed to fetch messages.' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/messages                                                   */
/* Body: { text: string }                                              */
/* Inserts the message, then broadcasts it to all SSE clients.         */
/* ------------------------------------------------------------------ */
router.post('/', async (req, res) => {
  const { text } = req.body ?? {};

  if (typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: 'Field "text" is required and must be a non-empty string.' });
  }

  const sanitised = text.trim();

  try {
    const db = await getDb();
    const result = await db.query(
      'INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at',
      [sanitised]
    );

    const message = result.rows[0];

    // Push the new message to every connected SSE client immediately.
    broadcast('new-message', message);

    res.status(201).json(message);
  } catch (err) {
    console.error('[POST /api/messages]', err);
    res.status(500).json({ error: 'Failed to save message.' });
  }
});

export default router;
