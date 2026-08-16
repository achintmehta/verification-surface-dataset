import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { getBoard, createCard, moveCard } from './board.js';
import { addClient, removeClient, broadcast, clientCount } from './sse.js';

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

// --- Board state ---------------------------------------------------------

app.get('/api/board', async (_req, res, next) => {
  try {
    const board = await getBoard();
    res.json(board);
  } catch (err) {
    next(err);
  }
});

// --- Create a card -------------------------------------------------------

app.post('/api/cards', async (req, res, next) => {
  try {
    const { columnId, text } = req.body ?? {};
    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }
    if (text == null || `${text}`.trim() === '') {
      return res.status(400).json({ error: 'text is required' });
    }
    const card = await createCard({ columnId, text: `${text}`.trim() });
    broadcast('card:create', { card });
    res.status(201).json({ card });
  } catch (err) {
    next(err);
  }
});

// --- Move / reorder a card ----------------------------------------------

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const cardId = req.params.id;
    const { columnId, beforeId = null, afterId = null } = req.body ?? {};
    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }
    const result = await moveCard({ cardId, columnId, beforeId, afterId });
    // Broadcast the canonical card and the full ordered column so clients can
    // reconcile their optimistic guesses against authoritative ordering.
    broadcast('card:move', {
      card: result.card,
      column: result.column,
    });
    res.json(result);
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
  res.write('retry: 3000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  const client = addClient(res);

  // Periodic heartbeat to keep the connection alive through proxies.
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

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, clients: clientCount() });
});

// --- Error handler -------------------------------------------------------

app.use((err, _req, res, _next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal Server Error' });
});

async function main() {
  await initDb();
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start server:', err);
  process.exit(1);
});
