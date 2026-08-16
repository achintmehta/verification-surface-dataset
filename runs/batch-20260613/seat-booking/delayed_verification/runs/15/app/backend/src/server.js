import express from 'express';
import cors from 'cors';

import { PORT, SWEEP_INTERVAL_MS, HOLD_TTL_MS } from './config.js';
import { initDb } from './db.js';
import { addClient } from './sse.js';
import {
  getSeats,
  getInventory,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpiredHolds,
  BookingError,
} from './booking.js';

const app = express();
app.use(cors());
app.use(express.json());

// --- Health & config ---
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, holdTtlMs: HOLD_TTL_MS });
});

// --- Seat map ---
app.get('/api/seats', async (_req, res, next) => {
  try {
    const seats = await getSeats();
    const inventory = await tallyFromSeats(seats);
    res.json({ seats, inventory, holdTtlMs: HOLD_TTL_MS });
  } catch (err) {
    next(err);
  }
});

app.get('/api/inventory', async (_req, res, next) => {
  try {
    res.json(await getInventory());
  } catch (err) {
    next(err);
  }
});

function tallyFromSeats(seats) {
  const counts = { available: 0, held: 0, booked: 0, total: seats.length };
  for (const s of seats) counts[s.status]++;
  return counts;
}

// --- Holds ---
app.post('/api/holds', async (req, res, next) => {
  try {
    const { seatIds, sessionId } = req.body || {};
    const hold = await createHold(seatIds, sessionId);
    res.status(201).json(hold);
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const result = await confirmHold(req.params.holdId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const result = await releaseHold(req.params.holdId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// --- SSE stream ---
app.get('/api/stream', (req, res) => {
  addClient(req, res);
});

// --- Error handler ---
app.use((err, _req, res, _next) => {
  if (err instanceof BookingError) {
    return res.status(err.status).json({
      error: err.code,
      message: err.message,
      ...err.extra,
    });
  }
  console.error('Unexpected error:', err);
  res.status(500).json({ error: 'internal_error', message: 'Internal server error' });
});

async function main() {
  await initDb();

  // Periodic sweep to release stale holds even without read traffic.
  setInterval(() => {
    sweepExpiredHolds().catch((e) => console.error('Sweep error:', e));
  }, SWEEP_INTERVAL_MS);

  app.listen(PORT, () => {
    console.log(`Seat-booking backend listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
