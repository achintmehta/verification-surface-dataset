import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import express from 'express';
import cors from 'cors';

import { initDb, getAllMessages, insertMessage } from './db.js';
import { addClient, broadcast, clientCount } from './sse.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3000;

async function main() {
  await initDb();

  const app = express();
  app.use(cors());
  app.use(express.json());

  // --- Health check -------------------------------------------------------
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', clients: clientCount() });
  });

  // --- Historical messages (initial state) --------------------------------
  app.get('/api/messages', async (_req, res) => {
    try {
      const messages = await getAllMessages();
      res.json(messages);
    } catch (err) {
      console.error('Failed to fetch messages:', err);
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  });

  // --- Post a new message -------------------------------------------------
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
      // Push the new message to all connected SSE clients.
      broadcast('message', message);
      res.status(201).json(message);
    } catch (err) {
      console.error('Failed to insert message:', err);
      res.status(500).json({ error: 'Failed to insert message' });
    }
  });

  // --- SSE stream ---------------------------------------------------------
  app.get('/api/stream', (req, res) => {
    addClient(req, res);
  });

  // --- Serve the built frontend in production (if present) ----------------
  const clientDist = resolve(__dirname, '..', '..', 'client', 'dist');
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get('*', (_req, res) => {
      res.sendFile(resolve(clientDist, 'index.html'));
    });
  }

  app.listen(PORT, () => {
    console.log(`Realtime board server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});
