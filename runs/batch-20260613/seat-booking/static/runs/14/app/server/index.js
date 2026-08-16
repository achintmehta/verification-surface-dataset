import express from 'express';
import cors from 'cors';
import { PORT, SWEEP_INTERVAL_MS } from './config.js';
import { initDb } from './db.js';
import { addClient } from './sse.js';
import {
  getSeatMap,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpired,
  getInventory,
  HoldConflictError,
  HoldError,
} from './seatService.js';

const app = express();
app.use(cors());
app.use(express.json());

// --- Seat map ---
app.get('/api/seats', async (_req, res, next) => {
  try {
    const seats = await getSeatMap();
    res.json({ seats });
  } catch (err) {
    next(err);
  }
});

// --- Inventory (diagnostics / acceptance) ---
app.get('/api/inventory', async (_req, res, next) => {
  try {
    res.json(await getInventory());
  } catch (err) {
    next(err);
  }
});

// --- Create a hold (atomic, all-or-nothing) ---
app.post('/api/holds', async (req, res, next) => {
  try {
    const { seatIds, sessionId } = req.body || {};
    const out = await createHold(seatIds, sessionId);
    res.status(201).json(out);
  } catch (err) {
    if (err instanceof HoldConflictError) {
      return res.status(409).json({
        error: 'SEATS_UNAVAILABLE',
        message: err.message,
        conflictingSeatIds: err.conflictingSeatIds,
      });
    }
    if (err instanceof HoldError && err.code === 'BAD_REQUEST') {
      return res.status(400).json({ error: err.code, message: err.message });
    }
    next(err);
  }
});

// --- Confirm a hold (idempotent) ---
app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const out = await confirmHold(req.params.holdId);
    res.json(out);
  } catch (err) {
    if (err instanceof HoldError) {
      const status =
        err.code === 'UNKNOWN_HOLD'
          ? 404
          : err.code === 'HOLD_EXPIRED' || err.code === 'HOLD_NOT_ACTIVE'
            ? 409
            : 400;
      return res.status(status).json({ error: err.code, message: err.message });
    }
    next(err);
  }
});

// --- Release a hold early ---
app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const seats = await releaseHold(req.params.holdId);
    res.json({ released: true, seats });
  } catch (err) {
    if (err instanceof HoldError) {
      const status = err.code === 'UNKNOWN_HOLD' ? 404 : 409;
      return res.status(status).json({ error: err.code, message: err.message });
    }
    next(err);
  }
});

// --- SSE stream ---
app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  // Initial comment to open the stream.
  res.write(': connected\n\n');
  addClient(res);

  // Heartbeat to keep the connection alive through proxies.
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 25_000);
  req.on('close', () => clearInterval(heartbeat));
});

// --- Error handler ---
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'INTERNAL', message: err.message });
});

async function main() {
  await initDb();

  // Background sweep to release stale holds even when nobody is reading.
  setInterval(() => {
    sweepExpired().catch((e) => console.error('sweep error', e));
  }, SWEEP_INTERVAL_MS);

  app.listen(PORT, () => {
    console.log(`Seat-booking server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
