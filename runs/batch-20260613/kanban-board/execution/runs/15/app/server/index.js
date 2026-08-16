import express from 'express';
import cors from 'cors';
import { getBoard, createCard, moveCard, ApiError } from './board.js';
import { addClient, broadcast, clientCount } from './sse.js';
import { getDb } from './db.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

const app = express();
app.use(cors());
app.use(express.json());

// --- Board state -----------------------------------------------------------

app.get('/api/board', async (_req, res, next) => {
  try {
    const board = await getBoard();
    res.json(board);
  } catch (err) {
    next(err);
  }
});

// --- Create a card ---------------------------------------------------------

app.post('/api/cards', async (req, res, next) => {
  try {
    const { columnId, text } = req.body ?? {};
    const card = await createCard({ columnId, text });
    // Broadcast canonical created card to every client (including the author;
    // the author de-dupes by id).
    broadcast('card:create', { card });
    res.status(201).json({ card });
  } catch (err) {
    next(err);
  }
});

// --- Move / reorder a card -------------------------------------------------

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const cardId = req.params.id;
    const { columnId, beforeId = null, afterId = null } = req.body ?? {};
    if (!columnId) {
      throw new ApiError(400, 'columnId is required');
    }
    const { card, renormalized } = await moveCard({
      cardId,
      columnId,
      beforeId,
      afterId,
    });

    // Broadcast the canonical move. If a renormalization happened, include the
    // corrected full ordering of the affected column so all clients snap to it.
    broadcast('card:move', { card, renormalized });

    res.json({ card, renormalized });
  } catch (err) {
    next(err);
  }
});

// --- SSE stream ------------------------------------------------------------

app.get('/api/stream', (req, res) => {
  addClient(req, res);
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, clients: clientCount() });
});

// --- Error handler ---------------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err instanceof ApiError ? err.status : 500;
  if (status >= 500) {
    console.error(err);
  }
  res.status(status).json({ error: err.message || 'Internal Server Error' });
});

async function start() {
  // Initialize the DB (and seed) before accepting traffic.
  await getDb();
  app.listen(PORT, () => {
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
