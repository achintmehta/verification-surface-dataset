import { Router } from 'express';
import { getDb } from './db.js';
import { addClient, broadcast } from './sse.js';

const router = Router();

// ─── GET /api/messages ────────────────────────────────────────────────────────
// Returns all messages ordered oldest-first so the client can render history.
router.get('/messages', async (_req, res) => {
  try {
    const db = getDb();
    const result = await db.query(
      'SELECT id, text, created_at FROM messages ORDER BY created_at ASC, id ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[routes] GET /messages error:', err);
    res.status(500).json({ error: 'Failed to fetch messages.' });
  }
});

// ─── POST /api/messages ───────────────────────────────────────────────────────
// Inserts a new message and broadcasts it to all SSE clients.
router.post('/messages', async (req, res) => {
  const text = (req.body?.text ?? '').trim();

  if (!text) {
    return res.status(400).json({ error: 'Message text must not be empty.' });
  }

  if (text.length > 2000) {
    return res.status(400).json({ error: 'Message text must be 2000 characters or fewer.' });
  }

  try {
    const db = getDb();
    const result = await db.query(
      'INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at',
      [text]
    );
    const message = result.rows[0];

    // Fan out to every connected SSE client
    broadcast('new-message', message);

    res.status(201).json(message);
  } catch (err) {
    console.error('[routes] POST /messages error:', err);
    res.status(500).json({ error: 'Failed to save message.' });
  }
});

// ─── GET /api/stream ──────────────────────────────────────────────────────────
// SSE endpoint – keeps the connection open and pushes events.
router.get('/stream', (req, res) => {
  addClient(req, res);
});

export default router;
