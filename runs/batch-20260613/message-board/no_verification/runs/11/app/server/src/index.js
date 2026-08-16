import express from 'express';
import cors from 'cors';

import { initDb, getAllMessages, insertMessage } from './db.js';
import { addClient, broadcast, clientCount } from './sse.js';

const PORT = process.env.PORT || 3001;

const app = express();

app.use(cors());
app.use(express.json());

/**
 * Health/diagnostics endpoint.
 */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', clients: clientCount() });
});

/**
 * GET /api/messages
 * Fetch the full message history (initial state for new clients).
 */
app.get('/api/messages', async (_req, res) => {
  try {
    const messages = await getAllMessages();
    res.json(messages);
  } catch (err) {
    console.error('Failed to fetch messages:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

/**
 * POST /api/messages
 * Insert a new message and broadcast it to all connected SSE clients.
 */
app.post('/api/messages', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';

  if (!text) {
    return res.status(400).json({ error: 'Message text is required' });
  }

  if (text.length > 2000) {
    return res.status(400).json({ error: 'Message text is too long (max 2000 chars)' });
  }

  try {
    const message = await insertMessage(text);
    // Push the new message out to everyone listening on the SSE stream.
    broadcast('message', message);
    res.status(201).json(message);
  } catch (err) {
    console.error('Failed to insert message:', err);
    res.status(500).json({ error: 'Failed to insert message' });
  }
});

/**
 * GET /api/stream
 * Server-Sent Events endpoint. Keeps the connection open and streams new
 * messages to the client as they arrive.
 */
app.get('/api/stream', (req, res) => {
  addClient(req, res);
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Realtime board server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Fatal error during server startup:', err);
  process.exit(1);
});
