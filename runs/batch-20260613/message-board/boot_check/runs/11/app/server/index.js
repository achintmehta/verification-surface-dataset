import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { addClient, broadcast } from './sse.js';

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

// Initialize the database before handling requests that need it.
const db = await getDb();

/**
 * GET /api/messages
 * Fetch historical messages (initial state) ordered oldest -> newest.
 */
app.get('/api/messages', async (_req, res) => {
  try {
    const result = await db.query(
      'SELECT id, text, created_at FROM messages ORDER BY created_at ASC, id ASC;'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Failed to fetch messages:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

/**
 * POST /api/messages
 * Insert a new message, then broadcast it to all connected SSE clients.
 */
app.post('/api/messages', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';

  if (!text) {
    return res.status(400).json({ error: 'Message text is required' });
  }

  try {
    const result = await db.query(
      'INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at;',
      [text]
    );
    const message = result.rows[0];

    broadcast('message', message);

    res.status(201).json(message);
  } catch (err) {
    console.error('Failed to insert message:', err);
    res.status(500).json({ error: 'Failed to insert message' });
  }
});

/**
 * GET /api/stream
 * Server-Sent Events stream that pushes new messages to clients in real time.
 */
app.get('/api/stream', (req, res) => {
  const removeClient = addClient(res);

  // Keep the connection alive through proxies with periodic comments.
  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      /* ignore */
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    removeClient();
  });
});

app.listen(PORT, () => {
  console.log(`Realtime board server listening on http://localhost:${PORT}`);
});
