import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import { initDb } from './db.js';
import {
  getBoard,
  createCard,
  moveCard,
  getColumnCards,
} from './board.js';
import { addClient, removeClient, broadcast, clientCount } from './sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

async function main() {
  await initDb();

  const app = express();
  app.use(cors());
  app.use(express.json());

  // --- Board state -------------------------------------------------------
  app.get('/api/board', async (_req, res, next) => {
    try {
      res.json(await getBoard());
    } catch (err) {
      next(err);
    }
  });

  // --- Create a card -----------------------------------------------------
  app.post('/api/cards', async (req, res, next) => {
    try {
      const { columnId, text } = req.body ?? {};
      const card = await createCard({ columnId, text });
      broadcast('card:create', { card });
      res.status(201).json({ card });
    } catch (err) {
      next(err);
    }
  });

  // --- Move / reorder a card --------------------------------------------
  app.patch('/api/cards/:id/move', async (req, res, next) => {
    try {
      const { columnId, beforeId, afterId } = req.body ?? {};
      const { card, renormalizedColumnId } = await moveCard({
        cardId: req.params.id,
        columnId,
        beforeId: beforeId ?? null,
        afterId: afterId ?? null,
      });

      // Always broadcast the canonical card so all clients converge.
      broadcast('card:move', { card });

      // If we had to renormalize, broadcast the corrected order of the whole
      // column so clients snap to the authoritative ordering.
      if (renormalizedColumnId) {
        const cards = await getColumnCards(renormalizedColumnId);
        broadcast('column:reorder', { columnId: renormalizedColumnId, cards });
      }

      res.json({ card, renormalized: Boolean(renormalizedColumnId) });
    } catch (err) {
      next(err);
    }
  });

  // --- Server-Sent Events stream ----------------------------------------
  app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    const client = addClient(res);

    // Periodic comment keeps proxies / browsers from closing idle streams.
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      removeClient(client);
    });
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, clients: clientCount() });
  });

  // --- Serve built frontend in production -------------------------------
  const distDir = path.join(__dirname, '..', 'dist');
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  // --- Error handler -----------------------------------------------------
  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || 'Internal Server Error' });
  });

  app.listen(PORT, () => {
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
