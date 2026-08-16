import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getDb, getMessages, insertMessage } from './db.js';
import { broadcaster } from './broadcaster.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

/**
 * GET /api/messages
 * Returns the full message history so a client can render initial state.
 */
app.get('/api/messages', async (_req, res, next) => {
  try {
    const messages = await getMessages();
    res.json(messages);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/messages
 * Insert a new message, then broadcast it to all connected SSE clients.
 * Body: { "text": "..." }
 */
app.post('/api/messages', async (req, res, next) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) {
      return res.status(400).json({ error: 'Message text is required.' });
    }

    const message = await insertMessage(text);
    broadcaster.broadcast('message', message);
    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/stream
 * Establishes a Server-Sent Events connection. Keeps the connection open
 * and pushes newly created messages to the client in real time.
 */
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  // Flush headers and send an initial comment so proxies open the stream.
  res.write(': connected\n\n');
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  const unsubscribe = broadcaster.addClient(res);

  // Periodic heartbeat keeps the connection from being closed by idle
  // timeouts in intermediate proxies/load balancers.
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// Serve the built frontend (production) if it exists.
const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// Centralized error handler.
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

async function start() {
  // Initialize the database (and create the schema) before listening.
  await getDb();
  app.listen(PORT, () => {
    console.log(`Realtime board server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
