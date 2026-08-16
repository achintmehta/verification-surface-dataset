import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import { initDb, getBoard, db } from './db.js';
import { createCard, moveCard } from './ordering.js';
import { addClient, removeClient, broadcast } from './sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Board state
// ---------------------------------------------------------------------------
app.get('/api/board', async (_req, res) => {
  try {
    const columns = await getBoard();
    res.json({ columns });
  } catch (err) {
    console.error('GET /api/board', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ---------------------------------------------------------------------------
// Create a card at the end of a column
// ---------------------------------------------------------------------------
app.post('/api/cards', async (req, res) => {
  const { columnId, text } = req.body || {};
  if (!columnId || typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: 'columnId and non-empty text required' });
  }
  try {
    const card = await createCard(columnId, text.trim());
    broadcast('card-created', { card });
    res.status(201).json({ card });
  } catch (err) {
    if (err.code === 'COLUMN_NOT_FOUND') {
      return res.status(404).json({ error: 'column_not_found' });
    }
    console.error('POST /api/cards', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ---------------------------------------------------------------------------
// Move/reorder a card
// ---------------------------------------------------------------------------
app.patch('/api/cards/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId, afterId } = req.body || {};
  if (!columnId) {
    return res.status(400).json({ error: 'columnId required' });
  }
  try {
    const { card, renormalizedColumns } = await moveCard(id, {
      columnId,
      beforeId: beforeId || null,
      afterId: afterId || null,
    });

    // Broadcast the canonical move first.
    broadcast('card-moved', { card });

    // If any column was renormalized, broadcast its corrected order so all
    // clients snap to the authoritative ordering.
    for (const [colId, cards] of Object.entries(renormalizedColumns)) {
      broadcast('column-reordered', { columnId: colId, cards });
    }

    res.json({ card, renormalizedColumns });
  } catch (err) {
    if (err.code === 'CARD_NOT_FOUND') return res.status(404).json({ error: 'card_not_found' });
    if (err.code === 'COLUMN_NOT_FOUND') return res.status(404).json({ error: 'column_not_found' });
    console.error('PATCH /api/cards/:id/move', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ---------------------------------------------------------------------------
// SSE stream
// ---------------------------------------------------------------------------
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  res.write(': connected\n\n');

  const id = addClient(res);

  // Heartbeat to keep proxies from closing idle connections.
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(id);
  });
});

// ---------------------------------------------------------------------------
// Serve built frontend in production (optional)
// ---------------------------------------------------------------------------
const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
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
  console.error('Failed to start server', err);
  process.exit(1);
});
