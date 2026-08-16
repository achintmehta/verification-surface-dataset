import express from 'express';
import cors from 'cors';
import { PORT, SWEEP_INTERVAL_MS } from './config.js';
import { initDb } from './db.js';
import {
  listSeats,
  inventory,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpired,
  setBroadcaster,
} from './seats.js';
import { addClient, removeClient, broadcast, startHeartbeat } from './sse.js';

const app = express();
app.use(cors());
app.use(express.json());

// Wire the seat logic to the SSE broadcaster.
setBroadcaster(broadcast);

// --- API routes ---------------------------------------------------------

// All seats with effective (expiry-aware) status.
app.get('/api/seats', async (_req, res) => {
  try {
    const seats = await listSeats();
    res.json({ seats });
  } catch (err) {
    console.error('GET /api/seats', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Inventory snapshot (available/held/booked/total) — useful for verification.
app.get('/api/inventory', async (_req, res) => {
  try {
    res.json(await inventory());
  } catch (err) {
    console.error('GET /api/inventory', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Create a hold over a set of seats (all-or-nothing).
app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body || {};
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'bad_request', message: 'seatIds must be a non-empty array.' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'bad_request', message: 'sessionId is required.' });
  }
  try {
    const result = await createHold(seatIds, sessionId);
    if (!result.ok) {
      return res.status(409).json({ error: 'seats_unavailable', conflicts: result.conflicts });
    }
    return res.status(201).json({ hold: result.hold });
  } catch (err) {
    console.error('POST /api/holds', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Confirm (book) a hold — idempotent.
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const sessionId = req.body?.sessionId;
  try {
    const result = await confirmHold(holdId, sessionId);
    if (!result.ok) {
      const status = result.error === 'forbidden' ? 403 : 409;
      return res.status(status).json({ error: result.error, message: result.message });
    }
    return res.json({ booking: result.booking, alreadyConfirmed: result.alreadyConfirmed });
  } catch (err) {
    console.error('POST /api/holds/:holdId/confirm', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Release a hold early.
app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const sessionId = req.query.sessionId || req.body?.sessionId;
  try {
    const result = await releaseHold(holdId, sessionId);
    if (!result.ok) {
      const status = result.error === 'forbidden' ? 403 : 409;
      return res.status(status).json({ error: result.error, message: result.message });
    }
    return res.json({ released: result.seatIds });
  } catch (err) {
    console.error('DELETE /api/holds/:holdId', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// SSE stream of seat-status transitions.
app.get('/api/stream', (req, res) => {
  const client = addClient(res);
  req.on('close', () => removeClient(client));
});

// --- Startup ------------------------------------------------------------

async function main() {
  await initDb();
  startHeartbeat();

  // Periodic sweep so abandoned holds are released even with no readers.
  const sweep = setInterval(() => {
    sweepExpired().catch((e) => console.error('sweep error', e));
  }, SWEEP_INTERVAL_MS);
  sweep.unref?.();

  app.listen(PORT, () => {
    console.log(`Seat-booking server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
