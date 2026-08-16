import express from 'express';
import cors from 'cors';
import { PORT, SWEEP_INTERVAL_MS, HOLD_TTL_MS } from './config.js';
import { initDb } from './db.js';
import { addClient } from './sse.js';
import {
  listSeats,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpiredHolds,
} from './booking.js';

const app = express();
app.use(cors());
app.use(express.json());

// --- Seat map ---------------------------------------------------------------
app.get('/api/seats', async (_req, res, next) => {
  try {
    const seats = await listSeats();
    res.json({ seats, holdTtlMs: HOLD_TTL_MS });
  } catch (err) {
    next(err);
  }
});

// --- Create a hold (atomic, all-or-nothing) ---------------------------------
app.post('/api/holds', async (req, res, next) => {
  try {
    const { seatIds, sessionId } = req.body || {};
    if (!Array.isArray(seatIds) || seatIds.length === 0) {
      return res.status(400).json({ error: 'seatIds must be a non-empty array' });
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    const result = await createHold(seatIds, sessionId);
    if (!result.ok) {
      return res.status(409).json({
        error: 'one or more seats are unavailable',
        conflicts: result.conflicts,
      });
    }
    return res.status(201).json({ hold: result.hold });
  } catch (err) {
    next(err);
  }
});

// --- Confirm a hold (transactional, idempotent) -----------------------------
app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const { holdId } = req.params;
    const sessionId = (req.body && req.body.sessionId) || null;
    const result = await confirmHold(holdId, sessionId);
    if (!result.ok) {
      return res.status(409).json({ error: result.reason });
    }
    return res.json({ booking: result.booking, idempotent: result.idempotent });
  } catch (err) {
    next(err);
  }
});

// --- Release a hold early ----------------------------------------------------
app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const { holdId } = req.params;
    const result = await releaseHold(holdId);
    return res.json(result);
  } catch (err) {
    next(err);
  }
});

// --- SSE stream --------------------------------------------------------------
app.get('/api/stream', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  // Send an initial comment + snapshot so the client syncs immediately.
  res.write(': connected\n\n');
  try {
    const seats = await listSeats();
    res.write(`event: snapshot\ndata: ${JSON.stringify({ seats })}\n\n`);
  } catch {
    // ignore snapshot failure; client will fetch /api/seats too
  }

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

// --- Error handler -----------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_server_error' });
});

async function main() {
  await initDb();

  // Periodic sweep to release stale holds even with no traffic.
  setInterval(() => {
    sweepExpiredHolds().catch((e) => console.error('sweep error', e));
  }, SWEEP_INTERVAL_MS);

  app.listen(PORT, () => {
    console.log(`Seat-booking server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
