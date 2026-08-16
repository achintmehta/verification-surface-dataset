// Express server: REST API for the seat map + holds/confirm/release, plus the
// SSE stream that broadcasts every seat-status transition.

import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { initDb } from './db.js';
import { addClient } from './sse.js';
import {
  getSeats,
  inventory,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpired,
} from './seatService.js';

const app = express();
app.use(cors());
app.use(express.json());

// --- Seat map ---
app.get('/api/seats', async (_req, res) => {
  try {
    const seats = await getSeats();
    res.json({ seats, inventory: inventory(seats), serverTime: Date.now() });
  } catch (err) {
    console.error('GET /api/seats failed', err);
    res.status(500).json({ error: 'Failed to load seats.' });
  }
});

// --- Create a hold (atomic, all-or-nothing) ---
app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body || {};

  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array.' });
  }
  const ids = seatIds.map((n) => Number(n));
  if (ids.some((n) => !Number.isInteger(n))) {
    return res.status(400).json({ error: 'seatIds must be integers.' });
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return res.status(400).json({ error: 'sessionId is required.' });
  }

  try {
    const result = await createHold([...new Set(ids)], sessionId);
    if (!result.ok) {
      return res.status(409).json({
        error: 'Some seats are no longer available.',
        conflicts: result.conflicts,
      });
    }
    res.status(201).json({
      holdId: result.holdId,
      expiresAt: result.expiresAt,
      ttlMs: result.ttlMs,
      seats: result.seats,
      serverTime: Date.now(),
    });
  } catch (err) {
    console.error('POST /api/holds failed', err);
    res.status(500).json({ error: 'Failed to create hold.' });
  }
});

// --- Confirm a hold (idempotent) ---
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body || {};
  try {
    const result = await confirmHold(holdId, sessionId);
    if (!result.ok) {
      return res.status(409).json({ error: result.error });
    }
    res.json({
      holdId: result.holdId,
      alreadyBooked: result.alreadyBooked,
      seats: result.seats,
      serverTime: Date.now(),
    });
  } catch (err) {
    console.error('POST /api/holds/:holdId/confirm failed', err);
    res.status(500).json({ error: 'Failed to confirm hold.' });
  }
});

// --- Release a hold early ---
app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;
  try {
    const result = await releaseHold(holdId);
    if (!result.ok) {
      return res.status(404).json({ error: result.error });
    }
    res.json({ released: true, seats: result.seats, serverTime: Date.now() });
  } catch (err) {
    console.error('DELETE /api/holds/:holdId failed', err);
    res.status(500).json({ error: 'Failed to release hold.' });
  }
});

// --- SSE stream ---
app.get('/api/stream', async (req, res) => {
  addClient(req, res);
  // Send the current snapshot immediately so a freshly-connected client is in
  // sync without waiting for the next transition.
  try {
    const seats = await getSeats();
    res.write(
      `event: snapshot\ndata: ${JSON.stringify({
        type: 'snapshot',
        seats,
        inventory: inventory(seats),
        serverTime: Date.now(),
      })}\n\n`
    );
  } catch {
    /* ignore snapshot failure; stream stays open */
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

async function start() {
  await initDb();

  // Periodic sweep to release leaked/abandoned holds.
  setInterval(() => {
    sweepExpired().catch((err) => console.error('sweep failed', err));
  }, config.sweepIntervalMs);

  app.listen(config.port, () => {
    console.log(`Seat-booking server listening on http://localhost:${config.port}`);
    console.log(
      `Seat map: ${config.rows} rows × ${config.seatsPerRow} seats, hold TTL ${config.holdTtlMs}ms`
    );
  });
}

start().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
