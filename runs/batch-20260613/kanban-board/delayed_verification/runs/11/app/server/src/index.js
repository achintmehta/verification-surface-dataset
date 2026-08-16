import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { getBoard, createCard, moveCard } from './board.js';
import { addClient, removeClient, broadcast } from './sse.js';

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
      // Broadcast the canonical card to every connected client.
      broadcast('card:create', { card });
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
      const result = await moveCard(id, {
        columnId,
        beforeId: beforeId || null,
        afterId: afterId || null,
      });
      // Broadcast only committed state. Include the full target-column
      // snapshot so clients reconcile against the authoritative order, which
      // is essential when a renormalization occurred.
      broadcast('card:move', {
        card: result.card,
        column: result.column,
        renormalized: result.renormalized,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // --- Server-Sent Events stream ------------------------------------------
  app.get('/api/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    // Initial comment to open the stream.
    res.write('retry: 3000\n\n');
    res.write(': connected\n\n');

    addClient(res);

    // Heartbeat keeps proxies from closing idle connections.
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

  // --- Error handler -------------------------------------------------------
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Internal Server Error' });
  });

  app.listen(PORT, () => {
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});
