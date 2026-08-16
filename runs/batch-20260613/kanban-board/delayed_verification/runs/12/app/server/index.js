import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { getBoard, createCard, moveCard } from './board.js';
import { addClient, broadcast } from './sse.js';

const PORT = process.env.PORT || 3001;

async function main() {
  await initDb();

  const app = express();
  app.use(cors());
  app.use(express.json());

  // --- Board state ---------------------------------------------------------
  app.get('/api/board', async (_req, res, next) => {
    try {
      const columns = await getBoard();
      res.json({ columns });
    } catch (err) {
      next(err);
    }
  });

  // --- Create a card -------------------------------------------------------
  app.post('/api/cards', async (req, res, next) => {
    try {
      const { columnId, text } = req.body || {};
      if (!columnId || typeof text !== 'string' || text.trim() === '') {
        return res
          .status(400)
          .json({ error: 'columnId and non-empty text are required' });
      }
      const card = await createCard(columnId, text.trim());
      broadcast('card:created', { card });
      res.status(201).json({ card });
    } catch (err) {
      next(err);
    }
  });

  // --- Move / reorder a card ----------------------------------------------
  app.patch('/api/cards/:id/move', async (req, res, next) => {
    try {
      const { id } = req.params;
      const { columnId, beforeId, afterId } = req.body || {};
      if (!columnId) {
        return res.status(400).json({ error: 'columnId is required' });
      }
      const { card, normalizedColumn } = await moveCard(id, {
        columnId,
        beforeId: beforeId ?? null,
        afterId: afterId ?? null
      });

      // Broadcast the canonical move. If a renormalization occurred we also
      // broadcast the corrected ordering of the affected column so every
      // client snaps to the same total order.
      broadcast('card:moved', { card, columnId: card.columnId });
      if (normalizedColumn) {
        broadcast('column:normalized', {
          columnId,
          cards: normalizedColumn
        });
      }

      res.json({ card, normalizedColumn });
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
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);

    const remove = addClient(res);

    // Keep the connection alive through proxies/load balancers.
    const keepAlive = setInterval(() => {
      try {
        res.write(': keep-alive\n\n');
      } catch {
        /* ignore */
      }
    }, 20000);

    req.on('close', () => {
      clearInterval(keepAlive);
      remove();
    });
  });

  // --- Error handler -------------------------------------------------------
  // eslint-disable-next-line no-unused-vars
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
  console.error('Failed to start server:', err);
  process.exit(1);
});
