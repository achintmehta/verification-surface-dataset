import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initDb } from './db.js';
import { getBoard, createCard, moveCard, ApiError } from './board.js';
import { addClient, broadcast, clientCount } from './sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

// --- Board state ---------------------------------------------------------
app.get('/api/board', async (_req, res, next) => {
  try {
    const board = await getBoard();
    res.json({ columns: board });
  } catch (err) {
    next(err);
  }
});

// --- Create a card -------------------------------------------------------
app.post('/api/cards', async (req, res, next) => {
  try {
    const { columnId, text } = req.body || {};
    const card = await createCard(columnId, text);
    // Broadcast only after the row is committed.
    broadcast('card:create', { card });
    res.status(201).json({ card });
  } catch (err) {
    next(err);
  }
});

// --- Move / reorder a card ----------------------------------------------
app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { columnId, beforeId, afterId } = req.body || {};
    if (!columnId) {
      throw new ApiError(400, 'columnId is required');
    }
    const { card, renormalizedColumns } = await moveCard(id, {
      columnId,
      beforeId: beforeId ?? null,
      afterId: afterId ?? null,
    });

    // Atomic commit done; broadcast canonical state.
    broadcast('card:move', { card });
    for (const col of renormalizedColumns) {
      broadcast('column:renormalize', col);
    }

    res.json({ card, renormalizedColumns });
  } catch (err) {
    next(err);
  }
});

// --- SSE stream ----------------------------------------------------------
app.get('/api/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  // Send a hello so the client knows it's connected.
  res.write(`event: hello\ndata: ${JSON.stringify({ clients: clientCount() + 1 })}\n\n`);

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

// --- Serve built client (production) -------------------------------------
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// --- Error handling ------------------------------------------------------
app.use((err, _req, res, _next) => {
  const status = err instanceof ApiError ? err.status : 500;
  if (status === 500) console.error(err);
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
