import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { initDb, getMessages, insertMessage } from './db.js';
import { addClient, removeClient, broadcast } from './sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;

async function main() {
  // Initialize the embedded PGLite database (and schema) before serving.
  await initDb();

  const app = express();

  app.use(cors());
  app.use(express.json());

  // --- API routes -----------------------------------------------------------

  // Fetch initial / historical state.
  app.get('/api/messages', async (_req, res) => {
    try {
      const messages = await getMessages();
      res.json(messages);
    } catch (err) {
      console.error('Failed to fetch messages:', err);
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  });

  // Post a new message; insert into PGLite and broadcast to SSE clients.
  app.post('/api/messages', async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';

    if (!text) {
      return res.status(400).json({ error: 'Message text is required' });
    }

    try {
      const message = await insertMessage(text);
      // Notify all connected clients in real time.
      broadcast('message', message);
      res.status(201).json(message);
    } catch (err) {
      console.error('Failed to insert message:', err);
      res.status(500).json({ error: 'Failed to insert message' });
    }
  });

  // SSE endpoint: maintain an open connection per client.
  app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable proxy buffering so events flush immediately.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    // Send an initial comment to establish the stream.
    res.write(': connected\n\n');

    addClient(res);

    // Periodic heartbeat to keep the connection alive through proxies.
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      removeClient(res);
      res.end();
    });
  });

  // --- Static frontend (production build) -----------------------------------

  const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    // SPA fallback for any non-API GET route.
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
