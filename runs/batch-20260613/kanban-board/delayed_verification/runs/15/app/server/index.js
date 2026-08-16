import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { getBoard, createCard, moveCard } from './board.js';
import { addClient, broadcast, clientCount } from './sse.js';

const PORT = process.env.PORT || 3000;

async function main() {
  const db = await getDb();
  const app = express();

  app.use(cors());
  app.use(express.json());

  // --- Board state -----------------------------------------------------------
  app.get('/api/board', async (_req, res, next) => {
    try {
      const board = await getBoard(db);
      res.json(board);
    } catch (err) {
      next(err);
    }
  });

  // --- Create card -----------------------------------------------------------
  app.post('/api/cards', async (req, res, next) => {
    try {
      const { columnId, text } = req.body ?? {};
      const card = await createCard(db, columnId, text);
      // Broadcast committed state to everyone.
      broadcast('card:create', { card, columnId: card.column_id });
      res.status(201).json(card);
    } catch (err) {
      next(err);
    }
  });

  // --- Move card -------------------------------------------------------------
  app.patch('/api/cards/:id/move', async (req, res, next) => {
    try {
      const { columnId, beforeId, afterId } = req.body ?? {};
      if (!columnId) {
        return res.status(400).json({ error: 'columnId is required' });
      }
      const result = await moveCard(db, req.params.id, {
        columnId,
        beforeId: beforeId ?? null,
        afterId: afterId ?? null,
      });

      // Broadcast the canonical move. `columns` carries the full ordered card
      // list for every affected column so clients can snap to the exact order.
      broadcast('card:move', {
        card: result.card,
        columnId: result.card.column_id,
        sourceColumnId: result.sourceColumnId,
        renormalized: result.renormalized,
        columns: result.columns,
      });

      res.json({ card: result.card, columns: result.columns, renormalized: result.renormalized });
    } catch (err) {
      next(err);
    }
  });

  // --- SSE stream ------------------------------------------------------------
  app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    res.write(`event: hello\ndata: ${JSON.stringify({ connected: true })}\n\n`);

    const remove = addClient(res);

    // Keep-alive comment so proxies don't drop idle connections.
    const keepAlive = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        /* ignore */
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(keepAlive);
      remove();
    });
  });

  // --- Health ----------------------------------------------------------------
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, clients: clientCount() });
  });

  // --- Error handler ---------------------------------------------------------
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
