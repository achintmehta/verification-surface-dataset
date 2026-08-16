import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import { initDb } from './db.js';
import { getBoard, createCard, moveCard } from './board.js';
import { addClient, broadcast } from './sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

// --- API routes -----------------------------------------------------------

// Full authoritative board state.
app.get('/api/board', async (_req, res, next) => {
  try {
    const board = await getBoard();
    res.json({ columns: board });
  } catch (err) {
    next(err);
  }
});

// Create a card at the end of a column, then broadcast it.
app.post('/api/cards', async (req, res, next) => {
  try {
    const { columnId, text } = req.body || {};
    const card = await createCard({ columnId, text });
    broadcast('card-created', { card });
    res.status(201).json({ card });
  } catch (err) {
    next(err);
  }
});

// Move/reorder a card. Server computes canonical position atomically.
app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { columnId, beforeId, afterId } = req.body || {};
    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }
    const result = await moveCard({ cardId: id, columnId, beforeId, afterId });

    // Broadcast the canonical move so every client converges.
    broadcast('card-moved', { card: result.card });

    // If a renormalization happened, broadcast the whole corrected column so
    // clients snap to the canonical total ordering.
    if (result.renormalized && result.column) {
      broadcast('column-renormalized', { column: result.column });
    }

    res.json({ card: result.card, renormalized: !!result.renormalized });
  } catch (err) {
    next(err);
  }
});

// SSE stream endpoint.
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  const cleanup = addClient(res);
  req.on('close', cleanup);
});

// --- Static frontend (production build) ------------------------------------
const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// --- Error handler ---------------------------------------------------------
app.use((err, _req, res, _next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });
});

// --- Boot ------------------------------------------------------------------
initDb()
  .then(() => {
    app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`Kanban server listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to initialize database', err);
    process.exit(1);
  });
