import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDb, getMessages, insertMessage } from './db.js';
import { addClient, broadcast, clientCount } from './sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();

app.use(cors());
app.use(express.json());

// --- API routes -----------------------------------------------------------

// Health / status endpoint.
app.get('/api/health', (req, res) => {
  res.json({ ok: true, clients: clientCount() });
});

// Fetch historical messages to render initial state.
app.get('/api/messages', async (req, res) => {
  try {
    const messages = await getMessages();
    res.json(messages);
  } catch (err) {
    console.error('Failed to fetch messages:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Create a new message, persist it, and broadcast it to all SSE clients.
app.post('/api/messages', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';

  if (!text) {
    return res.status(400).json({ error: 'Message text is required' });
  }
  if (text.length > 2000) {
    return res.status(400).json({ error: 'Message is too long (max 2000 chars)' });
  }

  try {
    const message = await insertMessage(text);
    broadcast('message', message);
    res.status(201).json(message);
  } catch (err) {
    console.error('Failed to insert message:', err);
    res.status(500).json({ error: 'Failed to save message' });
  }
});

// SSE stream — clients connect here to receive live message updates.
app.get('/api/stream', (req, res) => {
  addClient(req, res);
});

// --- Optionally serve the built frontend in production ---------------------

const distDir = path.join(__dirname, '..', 'dist');
app.use(express.static(distDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distDir, 'index.html'), (err) => {
    if (err) next();
  });
});

// --- Startup ---------------------------------------------------------------

async function start() {
  // Ensure the database + schema are ready before accepting traffic.
  await getDb();
  app.listen(PORT, () => {
    console.log(`Realtime board server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
