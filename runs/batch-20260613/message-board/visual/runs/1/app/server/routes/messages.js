import { Router } from 'express';
import { getDb } from '../db.js';
import { broadcast } from '../sseClients.js';

const router = Router();

/**
 * GET /api/messages
 * Returns all messages ordered oldest-first so the client can render
 * the full history on initial page load.
 */
router.get('/', async (_req, res) => {
  try {
    const db = getDb();
    const result = await db.query(
      'SELECT id, text, created_at FROM messages ORDER BY created_at ASC, id ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /api/messages]', err);
    res.status(500).json({ error: 'Failed to fetch messages.' });
  }
});

/**
 * POST /api/messages
 * Inserts a new message and broadcasts it to all SSE clients.
 * Body: { text: string }
 */
router.post('/', async (req, res) => {
  const { text } = req.body ?? {};

  if (!text || typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: 'Message text is required.' });
  }

  try {
    const db = getDb();
    const result = await db.query(
      'INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at',
      [text.trim()]
    );
    const message = result.rows[0];

    // Push the new message to every connected SSE client
    broadcast('new-message', message);

    res.status(201).json(message);
  } catch (err) {
    console.error('[POST /api/messages]', err);
    res.status(500).json({ error: 'Failed to save message.' });
  }
});

export default router;
