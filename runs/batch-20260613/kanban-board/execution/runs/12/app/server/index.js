import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import { initDb } from './db.js';
import { getBoard, createCard, moveCard } from './board.js';
import { addClient, broadcast, clientCount } from './sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

// ---- Board state ---------------------------------------------------------

app.get('/api/board', async (_req, res, next) => {
  try {
    res.json(await getBoard());
  } catch (err) {
    next(err);
  }
});

// ---- Create card ---------------------------------------------------------

app.post('/api/cards', async (req, res, next) => {
  try {
    const { columnId, text } = req.body || {};
    const card = await createCard({ columnId, text });
    broadcast('card.created', { card, columnId: card.column_id });
    res.status(201).json({ card });
  } catch (err) {
    next(err);
  }
});

// ---- Move / reorder card -------------------------------------------------

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const { columnId, beforeId, afterId } = req.body || {};
    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }
    const result = await moveCard({
      cardId: req.params.id,
      columnId,
      beforeId: beforeId ?? null,
      afterId: afterId ?? null,
    });

    // Broadcast the canonical moved card. If the column required
    // renormalization, broadcast the full corrected order too so every client
    // converges to the exact server ordering.
    broadcast('card.moved', {
      card: result.card,
      columnId: result.card.column_id,
      renormalized: result.renormalized || null,
    });

    res.json({ card: result.card, renormalized: result.renormalized || null });
  } catch (err) {
    next(err);
  }
});

// ---- SSE stream ----------------------------------------------------------

app.get('/api/stream', (req, res) => {
  const cleanup = addClient(res);
  req.on('close', cleanup);
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, clients: clientCount() });
});

// ---- Static frontend (production build) ----------------------------------

const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// ---- Error handler -------------------------------------------------------

app.use((err, _req, res, _next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start server:', err);
  process.exit(1);
});
