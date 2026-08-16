import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { getBoard, createCard, moveCard } from './board.js';
import { addClient, broadcast, clientCount } from './sse.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

const app = express();
app.use(cors());
app.use(express.json());

// ---- Board state ---------------------------------------------------------

app.get('/api/board', async (_req, res, next) => {
  try {
    const board = await getBoard();
    res.json(board);
  } catch (err) {
    next(err);
  }
});

// ---- Create card ---------------------------------------------------------

app.post('/api/cards', async (req, res, next) => {
  try {
    const { columnId, text } = req.body ?? {};
    const { card } = await createCard({ columnId, text });
    // Broadcast canonical created card to every client (including the author).
    broadcast('card:create', { card });
    res.status(201).json({ card });
  } catch (err) {
    next(err);
  }
});

// ---- Move / reorder card -------------------------------------------------

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const cardId = req.params.id;
    const { columnId, beforeId, afterId } = req.body ?? {};
    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }

    const result = await moveCard({
      cardId,
      columnId,
      beforeId: beforeId ?? null,
      afterId: afterId ?? null,
    });

    // Broadcast the committed move. If the column was renormalized, include the
    // corrected order so all clients snap to the canonical positions.
    broadcast('card:move', {
      card: result.card,
      columnId: result.columnId,
      normalized: result.normalized ?? null,
    });

    res.json({
      card: result.card,
      columnId: result.columnId,
      normalized: result.normalized ?? null,
    });
  } catch (err) {
    next(err);
  }
});

// ---- SSE stream ----------------------------------------------------------

app.get('/api/stream', (req, res) => {
  addClient(req, res);
});

// ---- Health --------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, clients: clientCount() });
});

// ---- Error handler -------------------------------------------------------

app.use((err, _req, res, _next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  const status = err.status ?? 500;
  res.status(status).json({ error: err.message ?? 'Internal Server Error' });
});

async function start() {
  // Initialize the database (schema + seed) before accepting requests.
  await getDb();
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start server:', err);
  process.exit(1);
});
