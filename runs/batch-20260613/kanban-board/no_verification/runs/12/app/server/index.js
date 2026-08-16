import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDb } from './db.js';
import { getBoard, createCard, moveCard } from './board.js';
import { addClient, removeClient, broadcast } from './sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

async function main() {
  const db = await getDb();
  const app = express();

  app.use(cors());
  app.use(express.json());

  // --- Board state ---------------------------------------------------------

  app.get('/api/board', async (_req, res, next) => {
    try {
      const board = await getBoard(db);
      res.json({ columns: board });
    } catch (err) {
      next(err);
    }
  });

  // --- Create card ---------------------------------------------------------

  app.post('/api/cards', async (req, res, next) => {
    try {
      const { columnId, text } = req.body || {};
      if (!columnId || typeof text !== 'string' || text.trim() === '') {
        return res.status(400).json({ error: 'columnId and non-empty text are required' });
      }

      const card = await createCard(db, columnId, text.trim());
      broadcast('card:created', { card, columnId: card.column_id });
      res.status(201).json({ card });
    } catch (err) {
      next(err);
    }
  });

  // --- Move card -----------------------------------------------------------

  app.patch('/api/cards/:id/move', async (req, res, next) => {
    try {
      const { id } = req.params;
      const { columnId, beforeId = null, afterId = null } = req.body || {};
      if (!columnId) {
        return res.status(400).json({ error: 'columnId is required' });
      }

      const result = await moveCard(db, id, { columnId, beforeId, afterId });

      // Broadcast only committed state.
      broadcast('card:moved', {
        card: result.card,
        columnId: result.card.column_id
      });

      // If we renormalized, broadcast the corrected order for the column.
      if (result.renormalized && result.column) {
        broadcast('column:reordered', {
          columnId: result.column.id,
          cards: result.column.cards
        });
      }

      res.json({ card: result.card, renormalized: result.renormalized });
    } catch (err) {
      next(err);
    }
  });

  // --- SSE stream ----------------------------------------------------------

  app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    res.write(': connected\n\n');

    addClient(res);

    // Keep-alive heartbeat to prevent idle timeouts.
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      removeClient(res);
    });
  });

  // --- Static frontend (production build) ----------------------------------

  const distDir = path.join(__dirname, '..', 'dist');
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  // --- Error handler -------------------------------------------------------

  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
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
