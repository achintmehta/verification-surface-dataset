import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDb } from './db.js';
import {
  getSeats,
  getInventory,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpired,
  HOLD_TTL_MS,
} from './booking.js';
import { addClient, removeClient, clientCount } from './sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

// ---- API ----

app.get('/api/seats', async (req, res, next) => {
  try {
    const seats = await getSeats();
    res.json({ seats, ttlMs: HOLD_TTL_MS });
  } catch (e) {
    next(e);
  }
});

app.get('/api/inventory', async (req, res, next) => {
  try {
    res.json(await getInventory());
  } catch (e) {
    next(e);
  }
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const { seatIds, sessionId } = req.body || {};
    const result = await createHold(seatIds, sessionId);
    if (!result.ok) {
      return res
        .status(409)
        .json({ error: 'seats_unavailable', conflicts: result.conflicts });
    }
    res.status(201).json(result.hold);
  } catch (e) {
    if (e.code === 'BAD_REQUEST') {
      return res.status(400).json({ error: e.message });
    }
    next(e);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const result = await confirmHold(req.params.holdId);
    if (!result.ok) {
      const status = result.reason === 'not_found' ? 404 : 409;
      return res.status(status).json({ error: result.reason });
    }
    res.json(result.booking);
  } catch (e) {
    next(e);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const result = await releaseHold(req.params.holdId);
    if (!result.ok) {
      const status = result.reason === 'not_found' ? 404 : 409;
      return res.status(status).json({ error: result.reason });
    }
    res.json({ ok: true, releasedSeatIds: result.releasedSeatIds });
  } catch (e) {
    next(e);
  }
});

// ---- SSE ----

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  addClient(res);

  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {}
  }, 25_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    removeClient(res);
  });
});

// ---- Static frontend (production build) ----
const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// ---- Error handler ----
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

async function start() {
  await getDb();
  // Periodic sweep of expired holds.
  setInterval(() => {
    sweepExpired().catch((e) => console.error('sweep error', e));
  }, 5_000);

  app.listen(PORT, () => {
    console.log(`Seat-booking server listening on http://localhost:${PORT}`);
    console.log(`Hold TTL: ${HOLD_TTL_MS}ms; SSE clients: ${clientCount()}`);
  });
}

start().catch((e) => {
  console.error('Failed to start server', e);
  process.exit(1);
});
