import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { getBoard, createCard, moveCard } from './board.js';
import { addClient, broadcast } from './sse.js';

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

// --- Board state -----------------------------------------------------------

app.get('/api/board', async (_req, res, next) => {
  try {
    const board = await getBoard();
    res.json({ columns: board });
  } catch (err) {
    next(err);
  }
});

// --- Create a card ---------------------------------------------------------

app.post('/api/cards', async (req, res, next) => {
  try {
    const { columnId, text } = req.body || {};
    const card = await createCard({ columnId, text });
    // Broadcast the canonical created card to every connected client.
    broadcast('card:created', { card });
    res.status(201).json({ card });
  } catch (err) {
    next(err);
  }
});

// --- Move / reorder a card -------------------------------------------------

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const { columnId, beforeId, afterId } = req.body || {};
    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }
    const result = await moveCard({
      cardId: req.params.id,
      columnId,
      beforeId: beforeId ?? null,
      afterId: afterId ?? null,
    });
    // Broadcast canonical committed state: the moved card plus the full
    // ordering of the target column so clients can reconcile renormalization.
    broadcast('card:moved', {
      card: result.card,
      column: result.column,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// --- Server-Sent Events stream ---------------------------------------------

app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  // Initial comment to open the stream and a hello event with the connection id.
  res.write(': connected\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);

  const remove = addClient(res);

  // Keep the connection alive through proxies.
  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      clearInterval(keepAlive);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    remove();
  });
});

// --- Error handler ---------------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Internal Server Error' });
});

// --- Start -----------------------------------------------------------------

async function start() {
  await getDb(); // initialise schema & seed before accepting traffic
  app.listen(PORT, () => {
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

export { app };
