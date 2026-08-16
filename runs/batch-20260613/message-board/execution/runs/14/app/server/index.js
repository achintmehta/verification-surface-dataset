import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initDb, getDb } from './db.js';
import { addClient, broadcast, clientCount } from './sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3001;

async function main() {
  await initDb();
  console.log('[db] PGLite initialized');

  const app = express();
  app.use(cors());
  app.use(express.json());

  // --- Health check ---------------------------------------------------------
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', clients: clientCount() });
  });

  // --- GET /api/messages : historical message feed --------------------------
  app.get('/api/messages', async (_req, res) => {
    try {
      const db = getDb();
      const result = await db.query(
        'SELECT id, text, created_at FROM messages ORDER BY id ASC'
      );
      res.json(result.rows);
    } catch (err) {
      console.error('[GET /api/messages]', err);
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  });

  // --- GET /api/stream : SSE real-time channel ------------------------------
  app.get('/api/stream', (req, res) => {
    addClient(req, res);
    // Let the new client know the stream is live.
    res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  });

  // --- POST /api/messages : create a message --------------------------------
  app.post('/api/messages', async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';

    if (!text) {
      return res.status(400).json({ error: 'Message text is required' });
    }
    if (text.length > 2000) {
      return res.status(400).json({ error: 'Message is too long (max 2000 chars)' });
    }

    try {
      const db = getDb();
      const result = await db.query(
        'INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at',
        [text]
      );
      const message = result.rows[0];

      // Broadcast the new message to every connected SSE client.
      broadcast('message', message);

      res.status(201).json(message);
    } catch (err) {
      console.error('[POST /api/messages]', err);
      res.status(500).json({ error: 'Failed to save message' });
    }
  });

  // --- Serve the built frontend in production -------------------------------
  const distDir = path.join(__dirname, '..', 'dist');
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'), (err) => {
      if (err) next();
    });
  });

  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
