import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import { initDb } from './db.js';
import { getBoard, createCard, moveCard } from './board.js';
import { addClient, removeClient, broadcast } from './sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

// --- API ROUTES ---

// Full board state.
app.get('/api/board', async (req, res) => {
  try {
    const board = await getBoard();
    res.json({ columns: board });
  } catch (err) {
    console.error('GET /api/board failed:', err);
    res.status(500).json({ error: 'Failed to load board' });
  }
});

// Create a card at the end of a column.
app.post('/api/cards', async (req, res) => {
  try {
    const { columnId, text } = req.body || {};
    if (columnId == null || typeof text !== 'string' || text.trim() === '') {
      return res.status(400).json({ error: 'columnId and non-empty text are required' });
    }
    const card = await createCard(Number(columnId), text.trim());
    broadcast('card:create', { card });
    res.status(201).json({ card });
  } catch (err) {
    console.error('POST /api/cards failed:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to create card' });
  }
});

// Move a card between columns / reorder within a column.
app.patch('/api/cards/:id/move', async (req, res) => {
  try {
    const cardId = Number(req.params.id);
    const { columnId, beforeId, afterId } = req.body || {};
    if (columnId == null) {
      return res.status(400).json({ error: 'columnId is required' });
    }
    const { card, renormalizedColumn } = await moveCard(
      cardId,
      Number(columnId),
      beforeId == null ? null : Number(beforeId),
      afterId == null ? null : Number(afterId)
    );

    // Broadcast the canonical moved card. Clients reconcile to this state.
    broadcast('card:move', { card });

    // If the column was renormalized, broadcast the corrected full order so
    // every client snaps to the new canonical ordering.
    if (renormalizedColumn) {
      broadcast('column:reorder', renormalizedColumn);
    }

    res.json({ card, renormalized: !!renormalizedColumn });
  } catch (err) {
    console.error('PATCH /api/cards/:id/move failed:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to move card' });
  }
});

// SSE stream.
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write(': connected\n\n');

  const client = addClient(res);

  // Keep-alive heartbeat to prevent idle timeouts.
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

// --- STATIC FRONTEND (production build) ---
const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
