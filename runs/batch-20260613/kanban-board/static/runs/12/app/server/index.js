import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { getBoard, createCard, moveCard } from './board.js';
import { addClient, broadcast } from './sse.js';

const PORT = process.env.PORT || 3001;

async function main() {
  const db = await getDb();
  const app = express();

  app.use(cors());
  app.use(express.json());

  // --- Board state -------------------------------------------------------
  app.get('/api/board', async (_req, res, next) => {
    try {
      const board = await getBoard(db);
      res.json({ columns: board });
    } catch (err) {
      next(err);
    }
  });

  // --- Create a card -----------------------------------------------------
  app.post('/api/cards', async (req, res, next) => {
    try {
      const { columnId, text } = req.body || {};
      if (!columnId || typeof text !== 'string' || text.trim() === '') {
        return res.status(400).json({ error: 'columnId and non-empty text required' });
      }
      const card = await createCard(db, columnId, text.trim());
      broadcast('card:created', { card, columnId: card.columnId });
      res.status(201).json(card);
    } catch (err) {
      next(err);
    }
  });

  // --- Move / reorder a card --------------------------------------------
  app.patch('/api/cards/:id/move', async (req, res, next) => {
    try {
      const { id } = req.params;
      const { columnId, beforeId = null, afterId = null } = req.body || {};
      if (!columnId) {
        return res.status(400).json({ error: 'columnId required' });
      }
      const { card, renormalized, column } = await moveCard(db, id, {
        columnId,
        beforeId,
        afterId,
      });

      // Always broadcast the canonical card placement (committed state only).
      broadcast('card:moved', { card, columnId: card.columnId });

      // If the column was renormalized, broadcast the corrected total order
      // so every client snaps to the canonical positions.
      if (renormalized && column) {
        broadcast('column:reordered', { columnId, cards: column });
      }

      res.json({ card, renormalized });
    } catch (err) {
      next(err);
    }
  });

  // --- Real-time stream (SSE) -------------------------------------------
  app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    res.write(': connected\n\n');

    const remove = addClient(res);

    // Keep the connection alive through proxies.
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* cleaned up on close */
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      remove();
    });
  });

  // --- Error handler -----------------------------------------------------
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || 'Internal error' });
  });

  app.listen(PORT, () => {
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
