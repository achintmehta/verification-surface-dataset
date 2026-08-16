import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import { getDb } from './db.js';
import { getBoard, createCard, moveCard } from './board.js';
import { addClient, removeClient, broadcast } from './sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

const db = await getDb();

// --- Board state ---------------------------------------------------------

app.get('/api/board', async (_req, res) => {
  try {
    const columns = await getBoard(db);
    res.json({ columns });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load board' });
  }
});

// --- Create card ---------------------------------------------------------

app.post('/api/cards', async (req, res) => {
  const { columnId, text } = req.body || {};
  if (!columnId || typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: 'columnId and non-empty text are required' });
  }
  try {
    const card = await createCard(db, columnId, text.trim());
    broadcast('card.created', { card });
    res.status(201).json({ card });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

// --- Move / reorder card -------------------------------------------------

app.patch('/api/cards/:id/move', async (req, res) => {
  const cardId = req.params.id;
  const { columnId, beforeId = null, afterId = null } = req.body || {};
  if (!columnId) {
    return res.status(400).json({ error: 'columnId is required' });
  }
  try {
    const { card, renormalizedColumn } = await moveCard(db, cardId, {
      columnId,
      beforeId,
      afterId,
    });
    // Broadcast only committed state.
    broadcast('card.moved', { card, renormalizedColumn, columnId });
    res.json({ card, renormalizedColumn });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Failed to move card' });
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
  // Initial comment to open the stream.
  res.write('retry: 3000\n\n');
  res.write(': connected\n\n');

  addClient(res);

  // Heartbeat to keep the connection alive through proxies.
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(res);
  });
});

// --- Optionally serve built frontend -------------------------------------

const distDir = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Kanban server listening on http://localhost:${PORT}`);
});
