import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { addClient, broadcast } from './sse.js';

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

/**
 * GET /api/messages
 * Fetch the full message history, oldest first, for initial client state.
 */
app.get('/api/messages', async (_req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(
      'SELECT id, text, created_at FROM messages ORDER BY id ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Failed to fetch messages:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

/**
 * GET /api/stream
 * Open a Server-Sent Events stream. New messages are pushed as `message` events.
 */
app.get('/api/stream', (req, res) => {
  addClient(req, res);
});

/**
 * POST /api/messages
 * Insert a new text message and broadcast it to all connected SSE clients.
 */
app.post('/api/messages', async (req, res) => {
  const { text } = req.body ?? {};

  if (typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'Message text is required' });
  }

  try {
    const db = await getDb();
    const result = await db.query(
      'INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at',
      [text.trim()]
    );
    const message = result.rows[0];

    // Notify every connected client in real time.
    broadcast('message', message);

    res.status(201).json(message);
  } catch (err) {
    console.error('Failed to insert message:', err);
    res.status(500).json({ error: 'Failed to insert message' });
  }
});

// Initialize the database before accepting connections so the first request
// never races schema creation.
getDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Realtime board server listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });

export default app;
