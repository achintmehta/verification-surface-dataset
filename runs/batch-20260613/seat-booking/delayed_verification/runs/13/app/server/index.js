import express from 'express';
import cors from 'cors';
import { PORT, SWEEP_INTERVAL_MS, HOLD_TTL_MS } from './config.js';
import { getDb } from './db.js';
import { addClient } from './sse.js';
import {
  getSeatMap,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpiredHolds,
  getInventory
} from './seats.js';

const app = express();
app.use(cors());
app.use(express.json());

// --- Seat map ---------------------------------------------------------------
app.get('/api/seats', async (req, res, next) => {
  try {
    const seats = await getSeatMap();
    res.json({ seats, holdTtlMs: HOLD_TTL_MS });
  } catch (err) {
    next(err);
  }
});

// --- Inventory self-check ---------------------------------------------------
app.get('/api/inventory', async (req, res, next) => {
  try {
    res.json(await getInventory());
  } catch (err) {
    next(err);
  }
});

// --- Create a hold (atomic all-or-nothing) ----------------------------------
app.post('/api/holds', async (req, res, next) => {
  try {
    const { seatIds, sessionId } = req.body || {};
    const hold = await createHold(seatIds, sessionId);
    res.status(201).json({ hold });
  } catch (err) {
    if (err.code === 'CONFLICT') {
      return res.status(409).json({
        error: err.message,
        conflicts: err.conflicts || []
      });
    }
    if (err.code === 'BAD_REQUEST') {
      return res.status(400).json({ error: err.message, unknown: err.unknown });
    }
    next(err);
  }
});

// --- Confirm a hold (transactional, idempotent) -----------------------------
app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const booking = await confirmHold(req.params.holdId);
    res.json({ booking });
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: err.message });
    }
    if (err.code === 'EXPIRED') {
      return res.status(409).json({ error: err.message });
    }
    next(err);
  }
});

// --- Release a hold early ----------------------------------------------------
app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const result = await releaseHold(req.params.holdId);
    res.json(result);
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: err.message });
    }
    next(err);
  }
});

// --- SSE stream -------------------------------------------------------------
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  // Initial comment to open the stream and flush headers.
  res.write(': connected\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  addClient(res);

  // Heartbeat so proxies / clients keep the connection alive.
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 25_000);

  req.on('close', () => clearInterval(heartbeat));
});

// --- Error handler ----------------------------------------------------------
app.use((err, req, res, _next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// --- Boot -------------------------------------------------------------------
async function start() {
  await getDb(); // initialize schema + seed before serving

  // Periodic sweep to release stale holds even when nobody is reading.
  setInterval(() => {
    sweepExpiredHolds().catch((e) => console.error('sweep error', e));
  }, SWEEP_INTERVAL_MS);

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Seat-booking backend listening on http://localhost:${PORT}`);
  });
}

start().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start server', e);
  process.exit(1);
});
