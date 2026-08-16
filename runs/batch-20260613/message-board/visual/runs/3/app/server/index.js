import express from 'express';
import cors from 'cors';
import { initDb, getDb } from './db.js';
import { addClient, broadcast } from './sse.js';

const PORT = process.env.PORT || 3001;

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/messages
 * Returns all messages ordered oldest-first so the client can render history.
 */
app.get('/api/messages', async (_req, res) => {
  try {
    const db = getDb();
    const result = await db.query(
      'SELECT id, text, created_at FROM messages ORDER BY created_at ASC'
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
app.post('/api/messages', async (req, res) => {
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

/**
 * GET /api/stream
 * SSE endpoint — keeps the connection open and streams events to the client.
 */
app.get('/api/stream', (req, res) => {
  addClient(req, res);
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
(async () => {
  await initDb();
  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
})();
