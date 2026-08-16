import express from 'express';
import cors from 'cors';

import { getDb } from './db.js';
import { getBoard, createCard, moveCard } from './board.js';
import { addClient, removeClient, broadcast } from './sse.js';

const PORT = process.env.PORT || 3001;

async function main() {
  // Ensure the DB (and schema/seed) is ready before serving requests.
  await getDb();

  const app = express();
  app.use(cors());
  app.use(express.json());

  // --- Board state -------------------------------------------------------
  app.get('/api/board', async (_req, res, next) => {
    try {
      const board = await getBoard();
      res.json(board);
    } catch (err) {
      next(err);
    }
  });

  // --- Create card -------------------------------------------------------
  app.post('/api/cards', async (req, res, next) => {
    try {
      const { columnId, text } = req.body || {};
      if (!columnId || typeof text !== 'string' || text.trim() === '') {
        return res
          .status(400)
          .json({ error: 'columnId and non-empty text are required' });
      }

      const card = await createCard({ columnId, text: text.trim() });
      broadcast('card-created', { card, column: card.column_id });
      res.status(201).json(card);
    } catch (err) {
      next(err);
    }
  });

  // --- Move / reorder card ----------------------------------------------
  app.patch('/api/cards/:id/move', async (req, res, next) => {
    try {
      const { id } = req.params;
      const { columnId, beforeId = null, afterId = null } = req.body || {};
      if (!columnId) {
        return res.status(400).json({ error: 'columnId is required' });
      }

      const result = await moveCard({ id, columnId, beforeId, afterId });

      // Broadcast the canonical move. Include any renormalized cards so all
      // clients can correct their local ordering for the whole column.
      broadcast('card-moved', {
        card: result.card,
        column: result.column,
        renormalized: result.renormalized || null,
      });

      res.json({
        card: result.card,
        renormalized: result.renormalized || null,
      });
    } catch (err) {
      next(err);
    }
  });

  // --- SSE stream --------------------------------------------------------
  app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Flush headers immediately.
    res.write(': connected\n\n');

    const client = addClient(res);

    // Periodic heartbeat to keep proxies from closing the connection.
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

  // --- Error handler -----------------------------------------------------
  app.use((err, _req, res, _next) => {
    // eslint-disable-next-line no-console
    console.error(err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Internal Server Error' });
  });

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error starting server:', err);
  process.exit(1);
});
