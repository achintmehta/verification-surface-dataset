import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, getDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// SSE connection registry
// ---------------------------------------------------------------------------
// Each connected client keeps an open HTTP response that we write events to.
const clients = new Set();

/**
 * Broadcast a payload to every connected SSE client.
 * @param {string} event - the SSE event name
 * @param {object} data  - JSON-serialisable payload
 */
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Fetch historical messages (initial state).
app.get('/api/messages', async (_req, res) => {
  try {
    const db = getDb();
    const result = await db.query(
      'SELECT id, text, created_at FROM messages ORDER BY created_at ASC, id ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Failed to fetch messages:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Post a new message.
app.post('/api/messages', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';

  if (!text) {
    return res.status(400).json({ error: 'Message text is required' });
  }

  try {
    const db = getDb();
    const result = await db.query(
      'INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at',
      [text]
    );
    const message = result.rows[0];

    // Push the new message to all connected clients in real time.
    broadcast('message', message);

    res.status(201).json(message);
  } catch (err) {
    console.error('Failed to insert message:', err);
    res.status(500).json({ error: 'Failed to insert message' });
  }
});

// SSE stream endpoint: keeps the connection open and registers the client.
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // Disable proxy buffering so events flush immediately.
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  // Send an initial comment to establish the stream.
  res.write(': connected\n\n');

  clients.add(res);

  // Heartbeat to keep the connection alive through proxies.
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

// Serve the built frontend (production) if present.
const distDir = path.join(__dirname, '..', 'dist');
app.use(express.static(distDir));

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
