import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, db } from './db.js';
import { getBoard, createCard, moveCard } from './board.js';
import { addClient, broadcast } from './sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

// --- Board state ---------------------------------------------------------

app.get('/api/board', async (_req, res) => {
  try {
    const board = await getBoard();
    res.json(board);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load board' });
  }
});

// --- SSE stream ----------------------------------------------------------

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`event: connected\ndata: {}\n\n`);
  // Keep-alive comment ping.
  const ping = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {
      /* ignore */
    }
  }, 25000);
  req.on('close', () => clearInterval(ping));
  addClient(res);
});

// --- Create card ---------------------------------------------------------

app.post('/api/cards', async (req, res) => {
  const { columnId, text } = req.body || {};
  if (!columnId || typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: 'columnId and text are required' });
  }
  try {
    const { card } = await createCard(columnId, text.trim());
    broadcast('card-created', { card });
    res.status(201).json({ card });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || 'Failed to create card' });
  }
});

// --- Move card -----------------------------------------------------------

app.patch('/api/cards/:id/move', async (req, res) => {
  const cardId = req.params.id;
  const { columnId, beforeId = null, afterId = null } = req.body || {};
  if (!columnId) {
    return res.status(400).json({ error: 'columnId is required' });
  }
  try {
    const result = await moveCard(cardId, columnId, afterId, beforeId);

    // Hydrate the canonical card with its text for the broadcast.
    const textRes = await db.query('SELECT text FROM cards WHERE id = $1', [cardId]);
    const text = textRes.rows[0]?.text;
    const card = { ...result.card, text };

    if (result.renormalized) {
      broadcast('card-moved', {
        card,
        columnId: result.columnId,
        renormalized: true,
        columnOrder: result.columnOrder
      });
    } else {
      broadcast('card-moved', {
        card,
        columnId: result.columnId,
        renormalized: false
      });
    }

    res.json({ card, renormalized: result.renormalized, columnOrder: result.columnOrder || null });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || 'Failed to move card' });
  }
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

start().catch((e) => {
  console.error('Failed to start server', e);
  process.exit(1);
});
