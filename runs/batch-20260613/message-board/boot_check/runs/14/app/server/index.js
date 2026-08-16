import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// SSE connection management
// ---------------------------------------------------------------------------

// Set of active SSE client response objects.
const clients = new Set();

/**
 * Broadcast a payload to all connected SSE clients.
 * @param {object} data - JSON-serializable payload.
 */
function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Fetch historical messages (initial state).
app.get('/api/messages', async (req, res) => {
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

// SSE stream endpoint: keeps the connection open and pushes new messages.
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // Flush headers immediately so the client knows the connection is open.
  res.write(': connected\n\n');

  clients.add(res);

  // Periodic comment to keep connection alive through proxies.
  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
});

// Post a new message: insert into PGLite and broadcast to all clients.
app.post('/api/messages', async (req, res) => {
  const { text } = req.body || {};

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

    broadcast(message);
    res.status(201).json(message);
  } catch (err) {
    console.error('Failed to insert message:', err);
    res.status(500).json({ error: 'Failed to insert message' });
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start() {
  // Initialize the database eagerly so the schema exists before requests.
  await getDb();
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
