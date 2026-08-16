import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb } from './db.js';
import { addClient, broadcast } from './sse.js';
import { getBoard, createCard, moveCard } from './board.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

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
    const { columnId, text } = req.body || {};
    if (!columnId || typeof text !== 'string' || text.trim() === '') {
      return res.status(400).json({ error: 'columnId and non-empty text are required' });
    }
    const card = await createCard(columnId, text.trim());
    // Broadcast committed canonical state to all clients.
    broadcast('card-created', { card, columnId: card.column_id });
    res.status(201).json({ card });
  } catch (err) {
    next(err);
  }
});

// --- Move / reorder card -------------------------------------------------

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { columnId, beforeId = null, afterId = null } = req.body || {};
    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }

    const result = await moveCard(id, { columnId, beforeId, afterId });

    // Broadcast committed canonical state. Includes corrected column ordering
    // when a renormalization occurred so clients can snap to the exact order.
    broadcast('card-moved', {
      card: result.card,
      columnId: result.card.column_id,
      sourceColumnId: result.sourceColumnId,
      columns: result.columns || null,
    });

    res.json({ card: result.card, columns: result.columns || null });
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
  res.write('retry: 2000\n\n');
  res.write(': connected\n\n');

  const remove = addClient(res);

  // Heartbeat to keep the connection alive through proxies.
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    remove();
  });
});

// --- Static frontend (production build) ----------------------------------

const distDir = path.join(__dirname, '..', 'dist');
app.use(express.static(distDir));

// --- Error handler -------------------------------------------------------

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Internal Server Error' });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Kanban server listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
