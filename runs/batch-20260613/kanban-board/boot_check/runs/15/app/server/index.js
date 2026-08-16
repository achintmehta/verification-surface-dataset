import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

import { initDb } from './db.js';
import { addClient } from './sse.js';
import { createCard, moveCard, getBoard } from './ordering.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

// --- API routes ---

// Full board state.
app.get('/api/board', async (req, res, next) => {
  try {
    const board = await getBoard();
    res.json({ columns: board });
  } catch (err) {
    next(err);
  }
});

// Create a card at the end of a column.
app.post('/api/cards', async (req, res, next) => {
  try {
    const { columnId, text } = req.body;
    if (columnId == null || typeof text !== 'string' || text.trim() === '') {
      return res.status(400).json({ error: 'columnId and non-empty text required' });
    }
    const card = await createCard(Number(columnId), text.trim());
    res.status(201).json({ card });
  } catch (err) {
    next(err);
  }
});

// Move a card into a column between afterId and beforeId.
app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const cardId = Number(req.params.id);
    const { columnId, beforeId, afterId } = req.body;
    if (columnId == null) {
      return res.status(400).json({ error: 'columnId required' });
    }
    const result = await moveCard(
      cardId,
      Number(columnId),
      beforeId != null ? Number(beforeId) : null,
      afterId != null ? Number(afterId) : null
    );
    res.json(result);
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    next(err);
  }
});

// SSE stream of canonical mutations.
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');
  res.write(`data: ${JSON.stringify({ type: 'connected', payload: {} })}\n\n`);

  const remove = addClient(res);

  // Periodic heartbeat to keep the connection alive.
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

// --- Static frontend (production build) ---
const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// Error handler.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

async function main() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
