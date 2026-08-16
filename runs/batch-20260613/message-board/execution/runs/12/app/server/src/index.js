import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { addClient, broadcast, clientCount } from './sse.js';

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

/**
 * GET /api/messages
 * Returns the full message history, oldest first.
 */
app.get('/api/messages', async (_req, res, next) => {
  try {
    const db = await getDb();
    const result = await db.query(
      'SELECT id, text, created_at FROM messages ORDER BY id ASC'
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/messages
 * Inserts a new message and broadcasts it to all SSE clients.
 * Body: { text: string }
 */
app.post('/api/messages', async (req, res, next) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) {
      return res.status(400).json({ error: 'Message text is required.' });
    }
    if (text.length > 2000) {
      return res.status(400).json({ error: 'Message is too long (max 2000 chars).' });
    }

    const db = await getDb();
    const result = await db.query(
      'INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at',
      [text]
    );
    const message = result.rows[0];

    // Push the new message to every connected client in real time.
    broadcast('message', message);

    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/stream
 * Server-Sent Events endpoint. Keeps the connection open and streams
 * newly posted messages as they arrive.
 */
app.get('/api/stream', (req, res) => {
  addClient(req, res);
});

/**
 * Simple health check that also reports the number of connected SSE clients.
 */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, clients: clientCount() });
});

// Centralized error handler.
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Internal server error.' });
});

async function start() {
  // Initialize the database before accepting traffic.
  await getDb();
  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('[fatal] failed to start server:', err);
  process.exit(1);
});
