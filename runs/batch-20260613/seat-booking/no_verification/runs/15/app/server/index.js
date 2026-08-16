import express from 'express';
import cors from 'cors';

import { config } from './config.js';
import { initDb } from './db.js';
import { addClient, removeClient, clientCount } from './sse.js';
import {
  getSeats,
  createHold,
  confirmHold,
  releaseHold,
  expireStaleHolds,
  getInventory
} from './bookings.js';

const app = express();
app.use(cors());
app.use(express.json());

// --- Seat map -------------------------------------------------------------
app.get('/api/seats', async (req, res, next) => {
  try {
    const seats = await getSeats();
    res.json({ seats, ttlMs: config.holdTtlMs });
  } catch (err) {
    next(err);
  }
});

// --- Inventory (handy for verification) -----------------------------------
app.get('/api/inventory', async (req, res, next) => {
  try {
    res.json(await getInventory());
  } catch (err) {
    next(err);
  }
});

// --- Create a hold (all-or-nothing atomic acquisition) --------------------
app.post('/api/holds', async (req, res, next) => {
  try {
    const { seatIds, sessionId } = req.body || {};
    const result = await createHold(seatIds, sessionId);
    res.status(201).json(result);
  } catch (err) {
    if (err.statusCode === 409 || err.statusCode === 404) {
      return res.status(err.statusCode).json({
        error: err.message,
        conflicts: err.conflicts || []
      });
    }
    next(err);
  }
});

// --- Confirm a hold (idempotent) ------------------------------------------
app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const { sessionId } = req.body || {};
    const result = await confirmHold(req.params.holdId, sessionId);
    res.json(result);
  } catch (err) {
    if ([403, 404, 409, 410].includes(err.statusCode)) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    next(err);
  }
});

// --- Release a hold early --------------------------------------------------
app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const sessionId = req.body?.sessionId || req.query.sessionId;
    const result = await releaseHold(req.params.holdId, sessionId);
    res.json(result);
  } catch (err) {
    if ([403, 404, 409].includes(err.statusCode)) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    next(err);
  }
});

// --- SSE stream ------------------------------------------------------------
app.get('/api/stream', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  // Initial snapshot so a freshly connected client is immediately in sync.
  try {
    const seats = await getSeats();
    res.write(`event: snapshot\ndata: ${JSON.stringify({ seats, ttlMs: config.holdTtlMs })}\n\n`);
  } catch {
    res.write(`event: snapshot\ndata: ${JSON.stringify({ seats: [] })}\n\n`);
  }

  addClient(res);

  // Keep-alive comment ping every 20s to defeat proxy idle timeouts.
  const ping = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      clearInterval(ping);
    }
  }, 20_000);

  req.on('close', () => {
    clearInterval(ping);
    removeClient(res);
  });
});

// --- Health ----------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, clients: clientCount() });
});

// --- Error handler ---------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('[server error]', err);
  res.status(err.statusCode || 500).json({ error: err.message || 'Internal error' });
});

async function start() {
  await initDb();

  // Background sweep: periodically release stale holds (defence in depth on
  // top of lazy expiry enforced on every read/operation).
  setInterval(() => {
    expireStaleHolds().catch((e) => console.error('[sweep error]', e));
  }, config.sweepIntervalMs);

  app.listen(config.port, () => {
    console.log(`Seat-booking server listening on http://localhost:${config.port}`);
    console.log(`Seat map: ${config.rows} rows x ${config.seatsPerRow} seats, hold TTL ${config.holdTtlMs}ms`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
