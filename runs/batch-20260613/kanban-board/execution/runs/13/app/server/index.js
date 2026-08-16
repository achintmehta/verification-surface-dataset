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

  // --- Board state ---
  app.get('/api/board', async (_req, res, next) => {
    try {
      const columns = await getBoard();
      res.json({ columns });
    } catch (err) {
      next(err);
    }
  });

  // --- Create a card at the end of a column ---
  app.post('/api/cards', async (req, res, next) => {
    try {
      const { columnId, text } = req.body || {};
      if (!columnId || typeof text !== 'string' || text.trim() === '') {
        return res.status(400).json({ error: 'columnId and non-empty text are required' });
      }
      const card = await createCard(columnId, text.trim());
      broadcast('card:create', { card });
      res.status(201).json({ card });
    } catch (err) {
      next(err);
    }
  });

  // --- Move/reorder a card ---
  app.patch('/api/cards/:id/move', async (req, res, next) => {
    try {
      const { id } = req.params;
      const { columnId, beforeId = null, afterId = null } = req.body || {};
      if (!columnId) {
        return res.status(400).json({ error: 'columnId is required' });
      }
      const { card, normalizedColumn } = await moveCard(id, { columnId, beforeId, afterId });
      // Broadcast the committed move (single source of truth).
      broadcast('card:move', { card, normalizedColumn });
      res.json({ card, normalizedColumn });
    } catch (err) {
      next(err);
    }
  });

  // --- SSE stream ---
  app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    res.write(': connected\n\n');

    const client = addClient(res);

    // Heartbeat to keep the connection alive through proxies.
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      removeClient(client);
    });
  });

  // --- Error handler ---
  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || 'Internal error' });
  });

  app.listen(PORT, () => {
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
