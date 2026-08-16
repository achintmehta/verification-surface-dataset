import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { getDb } from './db.js';
import { getBoard, createCard, moveCard } from './board.js';
import { addClient, broadcast } from './sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

// GET /api/board - full authoritative board state.
app.get('/api/board', async (req, res) => {
  try {
    const board = await getBoard();
    res.json(board);
  } catch (err) {
    console.error('GET /api/board error', err);
    res.status(500).json({ error: 'Failed to load board' });
  }
});

// POST /api/cards - create a card at end of a column.
app.post('/api/cards', async (req, res) => {
  try {
    const { columnId, text } = req.body || {};
    if (columnId == null || typeof text !== 'string' || text.trim() === '') {
      return res.status(400).json({ error: 'columnId and non-empty text required' });
    }
    const card = await createCard(Number(columnId), text.trim());
    broadcast('card:create', { card });
    res.status(201).json({ card });
  } catch (err) {
    console.error('POST /api/cards error', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to create card' });
  }
});

// PATCH /api/cards/:id/move - move/reorder a card.
app.patch('/api/cards/:id/move', async (req, res) => {
  try {
    const cardId = Number(req.params.id);
    const { columnId, beforeId, afterId } = req.body || {};
    if (columnId == null) {
      return res.status(400).json({ error: 'columnId required' });
    }
    const result = await moveCard(
      cardId,
      Number(columnId),
      beforeId == null ? null : Number(beforeId),
      afterId == null ? null : Number(afterId)
    );
    // Broadcast canonical move: the moved card plus affected columns' orderings.
    broadcast('card:move', {
      card: result.card,
      columns: result.columns,
    });
    res.json(result);
  } catch (err) {
    console.error('PATCH /api/cards/:id/move error', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to move card' });
  }
});

// GET /api/stream - SSE endpoint.
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write(': connected\n\n');
  addClient(res);

  // Heartbeat to keep the connection alive through proxies.
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (e) {
      clearInterval(heartbeat);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
  });
});

// Serve built frontend if present (production).
const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

async function start() {
  await getDb(); // initialize DB + schema before listening.
  app.listen(PORT, () => {
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
