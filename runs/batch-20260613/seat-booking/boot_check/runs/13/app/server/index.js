import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import { getDb, TOTAL_SEATS } from './db.js';
import {
  getSeats,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpired,
  HOLD_TTL_MS,
} from './bookingService.js';
import { addClient, removeClient } from './sse.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// --- API routes ---

app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getSeats();
    const counts = seats.reduce(
      (acc, s) => {
        acc[s.status] = (acc[s.status] || 0) + 1;
        return acc;
      },
      { available: 0, held: 0, booked: 0 }
    );
    res.json({ seats, counts, total: TOTAL_SEATS, ttlMs: HOLD_TTL_MS });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message, ...(e.payload || {}) });
  }
});

app.post('/api/holds', async (req, res) => {
  try {
    const { seatIds, sessionId } = req.body || {};
    const hold = await createHold(seatIds, sessionId);
    res.status(201).json(hold);
  } catch (e) {
    res
      .status(e.statusCode || 500)
      .json({ error: e.message, ...(e.payload || {}) });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  try {
    const result = await confirmHold(req.params.holdId);
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message, ...(e.payload || {}) });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  try {
    const result = await releaseHold(req.params.holdId);
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message, ...(e.payload || {}) });
  }
});

// --- SSE stream ---
app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  res.write(`event: connected\ndata: {}\n\n`);

  addClient(res);

  // heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(`event: ping\ndata: {}\n\n`);
    } catch (_) {}
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(res);
  });
});

// --- Serve built frontend if present ---
const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

async function start() {
  await getDb();

  // Periodic sweep of expired holds.
  const sweepInterval = setInterval(() => {
    sweepExpired().catch((e) => console.error('sweep error', e));
  }, 5000);
  sweepInterval.unref?.();

  app.listen(PORT, () => {
    console.log(`Seat-booking server listening on http://localhost:${PORT}`);
  });
}

start().catch((e) => {
  console.error('Failed to start server', e);
  process.exit(1);
});
