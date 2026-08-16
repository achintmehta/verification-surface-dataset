import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { addClient, broadcast } from './sse.js';

const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

/**
 * GET /api/messages
 * Returns the full message history ordered oldest-first.
 */
app.get('/api/messages', async (_req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(
      'SELECT id, text, created_at FROM messages ORDER BY created_at ASC, id ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Failed to fetch messages:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

/**
 * POST /api/messages
 * Inserts a new message and broadcasts it to all SSE clients.
 * Body: { text: string }
 */
app.post('/api/messages', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';

  if (!text) {
    return res.status(400).json({ error: 'Message text is required' });
  }

  try {
    const db = await getDb();
    const result = await db.query(
      'INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at',
      [text]
    );
    const message = result.rows[0];

    broadcast('message', message);

    res.status(201).json(message);
  } catch (err) {
    console.error('Failed to create message:', err);
    res.status(500).json({ error: 'Failed to create message' });
  }
});

/**
 * GET /api/stream
 * Opens a Server-Sent Events stream for real-time message delivery.
 */
app.get('/api/stream', (req, res) => {
  addClient(req, res);
});

async function start() {
  // Eagerly initialize the database (and schema) before accepting traffic.
  await getDb();
  app.listen(PORT, () => {
    console.log(`Realtime board server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
