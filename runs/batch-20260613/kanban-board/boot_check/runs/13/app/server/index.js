import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDb } from './db.js';
import { getBoard, createCard, moveCard } from './board.js';
import { addClient, broadcast } from './sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

const db = await getDb();

// --- API ---

// Board state.
app.get('/api/board', async (req, res) => {
  try {
    const board = await getBoard(db);
    res.json({ columns: board });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to load board' });
  }
});

// Create a card at the end of a column.
app.post('/api/cards', async (req, res) => {
  const { columnId, text } = req.body || {};
  if (columnId == null || typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: 'columnId and non-empty text required' });
  }
  try {
    const card = await createCard(db, columnId, text.trim());
    broadcast('card.created', { card, columnId: card.column_id });
    res.status(201).json({ card });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to create card' });
  }
});

// Move / reorder a card.
app.patch('/api/cards/:id/move', async (req, res) => {
  const cardId = req.params.id;
  const { columnId, beforeId, afterId } = req.body || {};
  if (columnId == null) {
    return res.status(400).json({ error: 'columnId required' });
  }
  try {
    const result = await moveCard(
      db,
      cardId,
      columnId,
      beforeId ?? null,
      afterId ?? null
    );
    if (!result) {
      return res.status(404).json({ error: 'card or column not found' });
    }
    // Broadcast canonical committed state.
    broadcast('card.moved', {
      card: result.card,
      columnId: result.columnId,
      sourceColumnId: result.sourceColumnId,
      renormalized: result.renormalized,
      columns: result.columns,
    });
    res.json({ card: result.card, columns: result.columns });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to move card' });
  }
});

// SSE stream.
app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  res.write('retry: 2000\n\n');
  res.write(': connected\n\n');
  addClient(res);

  // Heartbeat to keep connection alive through proxies.
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 25000);
  req.on('close', () => clearInterval(heartbeat));
});

// --- Static frontend ---
// Serve built assets if present, otherwise serve the raw dev frontend.
const distDir = path.join(__dirname, '..', 'dist');
const publicDir = path.join(__dirname, '..', 'public');

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
} else if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(publicDir, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Kanban server listening on http://localhost:${PORT}`);
});
