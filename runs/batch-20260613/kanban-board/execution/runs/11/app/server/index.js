import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getDb } from './db.js';
import { getBoard, createCard, moveCard } from './board.js';
import { addClient, broadcast } from './sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

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

// --- Create a card ----------------------------------------------------------

app.post('/api/cards', async (req, res, next) => {
  try {
    const { columnId, text } = req.body || {};
    if (!columnId || typeof text !== 'string' || text.trim() === '') {
      return res.status(400).json({ error: 'columnId and non-empty text are required' });
    }
    const card = await createCard(columnId, text.trim());
    broadcast('card-created', { card });
    res.status(201).json({ card });
  } catch (err) {
    next(err);
  }
});

// --- Move / reorder a card --------------------------------------------------

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { columnId, beforeId = null, afterId = null } = req.body || {};
    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }

    const result = await moveCard(id, { columnId, beforeId, afterId });

    // Broadcast committed state only. If the column was renormalized we send
    // the corrected ordering so all clients snap to it.
    broadcast('card-moved', {
      card: result.card,
      columnId: result.columnId,
      renormalized: result.renormalized,
      column: result.column
    });

    res.json({ card: result.card, renormalized: result.renormalized, column: result.column });
  } catch (err) {
    next(err);
  }
});

// --- SSE stream -------------------------------------------------------------

app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  // Initial comment to establish the stream.
  res.write(': connected\n\n');

  const remove = addClient(res);

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
    remove();
  });
});

// --- Static frontend (production) -------------------------------------------

const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// --- Error handler ----------------------------------------------------------

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

// --- Boot -------------------------------------------------------------------

async function start() {
  await getDb(); // initialize schema before accepting traffic
  app.listen(PORT, () => {
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

start();
