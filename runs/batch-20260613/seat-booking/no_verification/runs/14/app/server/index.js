import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { initDb } from './db.js';
import { addClient } from './sse.js';
import {
  getSeats,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpired,
  getInventory,
} from './booking.js';

const app = express();
app.use(cors());
app.use(express.json());

// --- Health ---
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// --- Config (so the client knows the TTL) ---
app.get('/api/config', (_req, res) => {
  res.json({
    rows: config.rows,
    seatsPerRow: config.seatsPerRow,
    holdTtlMs: config.holdTtlMs,
  });
});

// --- Seat map ---
app.get('/api/seats', async (_req, res, next) => {
  try {
    const seats = await getSeats();
    res.json({ seats });
  } catch (err) {
    next(err);
  }
});

// --- Inventory counts ---
app.get('/api/inventory', async (_req, res, next) => {
  try {
    res.json(await getInventory());
  } catch (err) {
    next(err);
  }
});

// --- Create hold ---
app.post('/api/holds', async (req, res, next) => {
  try {
    const { seatIds, sessionId } = req.body || {};
    const hold = await createHold(seatIds, sessionId);
    res.status(201).json(hold);
  } catch (err) {
    if (err.statusCode === 409 && err.conflicts) {
      return res.status(409).json({
        error: 'conflict',
        message: 'Some seats are no longer available.',
        conflicts: err.conflicts,
      });
    }
    next(err);
  }
});

// --- Confirm hold ---
app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const { holdId } = req.params;
    const { sessionId } = req.body || {};
    const result = await confirmHold(holdId, sessionId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// --- Release hold ---
app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const { holdId } = req.params;
    const { sessionId } = req.body || {};
    const result = await releaseHold(holdId, sessionId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// --- Release hold via navigator.sendBeacon (which can only POST) ---
app.post('/api/holds/:holdId', async (req, res, next) => {
  try {
    const { holdId } = req.params;
    const { sessionId } = req.body || {};
    const result = await releaseHold(holdId, sessionId);
    res.json(result);
  } catch (err) {
    // Best-effort; swallow client-side errors for beacon calls.
    next(err);
  }
});

// --- SSE stream ---
app.get('/api/stream', (req, res) => {
  addClient(req, res);
});

// --- Error handler ---
app.use((err, _req, res, _next) => {
  const status = err.statusCode || 500;
  if (status >= 500) {
    console.error(err);
  }
  res.status(status).json({
    error: status === 500 ? 'internal_error' : 'request_error',
    message: err.message || 'Internal server error',
  });
});

async function main() {
  await initDb();

  // Background sweep to release abandoned holds even with no traffic.
  setInterval(() => {
    sweepExpired().catch((e) => console.error('sweep error', e));
  }, config.sweepIntervalMs);

  app.listen(config.port, () => {
    console.log(`Seat-booking server listening on http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
