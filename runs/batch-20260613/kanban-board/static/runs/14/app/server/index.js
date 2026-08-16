import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getDb } from './db.js';
import { getBoard, createCard, moveCard, getColumnCards } from './board.js';
import { addClient, broadcast } from './sse.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

// --- Board state ---------------------------------------------------------

app.get('/api/board', async (req, res, next) => {
  try {
    const board = await getBoard();
    res.json(board);
  } catch (err) {
    next(err);
  }
});

// --- Create card ---------------------------------------------------------

app.post('/api/cards', async (req, res, next) => {
  try {
    const { columnId, text } = req.body ?? {};
    const card = await createCard({ columnId, text });
    // Broadcast committed state to all clients.
    broadcast('card:created', { card });
    res.status(201).json({ card });
  } catch (err) {
    next(err);
  }
});

// --- Move / reorder card -------------------------------------------------

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const { columnId, beforeId, afterId } = req.body ?? {};
    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }
    const { card, renormalized, affectedColumnId } = await moveCard(
      req.params.id,
      { columnId, beforeId, afterId }
    );

    // Broadcast the canonical moved card to all clients.
    broadcast('card:moved', { card });

    // If the column was renormalized, broadcast the corrected total order so
    // every client converges to identical, collision-free positions.
    if (renormalized) {
      const cards = await getColumnCards(affectedColumnId);
      broadcast('column:reordered', { columnId: affectedColumnId, cards });
    }

    res.json({ card, renormalized });
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
    'X-Accel-Buffering': 'no',
  });
  // Initial comment to open the stream and flush headers.
  res.write(': connected\n\n');

  const remove = addClient(res);

  // Heartbeat to keep proxies/intermediaries from closing idle connections.
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

// --- Static frontend (production build) ----------------------------------

const distDir = join(__dirname, '..', 'dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  // SPA fallback for non-API routes.
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.sendFile(join(distDir, 'index.html'));
  });
}

// --- Error handler -------------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Internal Server Error' });
});

async function start() {
  // Ensure DB + schema are ready before accepting requests.
  await getDb();
  app.listen(PORT, () => {
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
