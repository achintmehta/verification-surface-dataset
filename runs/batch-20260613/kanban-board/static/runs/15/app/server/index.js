import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { getBoard, createCard, moveCard } from './board.js';
import { addClient, broadcast } from './sse.js';

const PORT = process.env.PORT || 3000;

async function main() {
  await initDb();

  const app = express();
  app.use(cors());
  app.use(express.json());

  // --- Board state ---------------------------------------------------------
  app.get('/api/board', async (_req, res, next) => {
    try {
      res.json(await getBoard());
    } catch (err) {
      next(err);
    }
  });

  // --- Create a card -------------------------------------------------------
  app.post('/api/cards', async (req, res, next) => {
    try {
      const { columnId, text } = req.body || {};
      const cid = Number(columnId);
      if (!Number.isInteger(cid)) {
        return res.status(400).json({ error: 'columnId is required' });
      }
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (!trimmed) {
        return res.status(400).json({ error: 'text is required' });
      }

      const card = await createCard(cid, trimmed);
      broadcast('card:create', { card });
      res.status(201).json({ card });
    } catch (err) {
      next(err);
    }
  });

  // --- Move / reorder a card ----------------------------------------------
  app.patch('/api/cards/:id/move', async (req, res, next) => {
    try {
      const cardId = Number(req.params.id);
      if (!Number.isInteger(cardId)) {
        return res.status(400).json({ error: 'invalid card id' });
      }
      const { columnId, beforeId, afterId } = req.body || {};
      const cid = Number(columnId);
      if (!Number.isInteger(cid)) {
        return res.status(400).json({ error: 'columnId is required' });
      }

      const { card, normalizedColumn } = await moveCard(cardId, {
        columnId: cid,
        beforeId: beforeId == null ? null : Number(beforeId),
        afterId: afterId == null ? null : Number(afterId),
      });

      // Broadcast the canonical, committed result to every client.
      broadcast('card:move', { card });
      if (normalizedColumn) {
        broadcast('column:normalize', normalizedColumn);
      }

      res.json({ card, normalizedColumn });
    } catch (err) {
      next(err);
    }
  });

  // --- Server-Sent Events stream ------------------------------------------
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
