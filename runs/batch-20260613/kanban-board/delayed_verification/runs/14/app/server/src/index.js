import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDb } from './db.js';
import { getBoard, createCard, moveCard, HttpError } from './board.js';
import { addClient, removeClient, broadcast } from './sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

// --- Board state -----------------------------------------------------------

app.get('/api/board', async (req, res, next) => {
  try {
    const board = await getBoard();
    res.json(board);
  } catch (err) {
    next(err);
  }
});

// --- Create card -----------------------------------------------------------

app.post('/api/cards', async (req, res, next) => {
  try {
    const { columnId, text } = req.body || {};
    const card = await createCard({ columnId, text });
    // Broadcast the canonical created card and its column id.
    broadcast('card:create', { card, columnId: card.column_id });
    res.status(201).json({ card });
  } catch (err) {
    next(err);
  }
});

// --- Move / reorder card ---------------------------------------------------

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { columnId, beforeId, afterId } = req.body || {};
    const result = await moveCard({ id, columnId, beforeId, afterId });

    // Broadcast the canonical move plus any renormalized column ordering so all
    // clients converge to identical, total ordering.
    broadcast('card:move', {
      card: result.card,
      columnId: result.card.column_id,
      columns: result.columns,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// --- SSE stream ------------------------------------------------------------

app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const client = addClient(res);

  // Periodic heartbeat keeps proxies/browsers from closing idle connections.
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

// --- Static client (production build) --------------------------------------
// If the client has been built (client/dist), serve it so `npm start` runs the
// whole app from the backend. In development the Vite dev server is used
// instead and proxies /api to here.

const clientDist = path.resolve(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// --- Error handling --------------------------------------------------------

app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

async function start() {
  // Ensure DB + schema are ready before accepting traffic.
  await getDb();
  app.listen(PORT, () => {
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
