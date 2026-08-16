import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { getBoard, createCard, moveCard } from './board.js';
import { addClient, broadcast, clientCount } from './sse.js';

const PORT = process.env.PORT || 3001;

async function main() {
  const db = await getDb();
  const app = express();

  app.use(cors());
  app.use(express.json());

  // --- Board state -----------------------------------------------------------
  app.get('/api/board', async (_req, res) => {
    try {
      const board = await getBoard(db);
      res.json({ columns: board });
    } catch (err) {
      console.error('GET /api/board failed', err);
      res.status(500).json({ error: 'failed to load board' });
    }
  });

  // --- Create a card ---------------------------------------------------------
  app.post('/api/cards', async (req, res) => {
    const { columnId, text } = req.body || {};
    if (!columnId || typeof text !== 'string' || text.trim() === '') {
      return res.status(400).json({ error: 'columnId and non-empty text are required' });
    }
    try {
      const card = await createCard(db, columnId, text.trim());
      broadcast('card-created', { card });
      res.status(201).json({ card });
    } catch (err) {
      const status = err.status || 500;
      console.error('POST /api/cards failed', err);
      res.status(status).json({ error: err.message || 'failed to create card' });
    }
  });

  // --- Move / reorder a card -------------------------------------------------
  app.patch('/api/cards/:id/move', async (req, res) => {
    const cardId = req.params.id;
    const { columnId, beforeId = null, afterId = null } = req.body || {};
    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }
    try {
      const { card, normalizedColumns } = await moveCard(db, cardId, {
        columnId,
        beforeId,
        afterId
      });

      // Broadcast the canonical move first.
      broadcast('card-moved', { card });

      // If any column was renormalized, broadcast the corrected order so all
      // clients (including the mover) snap to canonical positions.
      for (const nc of normalizedColumns) {
        broadcast('column-normalized', nc);
      }

      res.json({ card, normalizedColumns });
    } catch (err) {
      const status = err.status || 500;
      console.error('PATCH /api/cards/:id/move failed', err);
      res.status(status).json({ error: err.message || 'failed to move card' });
    }
  });

  // --- SSE stream ------------------------------------------------------------
  app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    addClient(res);

    // Heartbeat to keep proxies from closing idle connections.
    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        clearInterval(heartbeat);
      }
    }, 25000);
    req.on('close', () => clearInterval(heartbeat));
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, clients: clientCount() });
  });

  app.listen(PORT, () => {
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
