import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import { initDb, getDb } from './db.js';
import { sseHub } from './sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

async function main() {
  await initDb();

  const app = express();
  app.use(cors());
  app.use(express.json());

  // --- API routes ---------------------------------------------------------

  // GET /api/messages — fetch historical messages (oldest first).
  app.get('/api/messages', async (_req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(
        'SELECT id, text, created_at FROM messages ORDER BY created_at ASC, id ASC'
      );
      res.json(rows);
    } catch (err) {
      console.error('[api] failed to fetch messages:', err);
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  });

  // GET /api/stream — Server-Sent Events stream for live updates.
  app.get('/api/stream', (req, res) => {
    sseHub.addClient(req, res);
  });

  // POST /api/messages — insert a new message and broadcast it.
  app.post('/api/messages', async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) {
      return res.status(400).json({ error: 'Message text is required' });
    }

    try {
      const db = getDb();
      const { rows } = await db.query(
        'INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at',
        [text]
      );
      const message = rows[0];

      // Push the new message to every connected SSE client.
      sseHub.broadcast('message', message);

      res.status(201).json(message);
    } catch (err) {
      console.error('[api] failed to insert message:', err);
      res.status(500).json({ error: 'Failed to insert message' });
    }
  });

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', clients: sseHub.clientCount });
  });

  // --- Static frontend (production build) ---------------------------------
  const clientDist = path.resolve(__dirname, '..', '..', 'client', 'dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    // SPA fallback for any non-API route.
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
    console.log(`[server] serving static client from ${clientDist}`);
  }

  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] fatal startup error:', err);
  process.exit(1);
});
