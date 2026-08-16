import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { PORT, SWEEP_INTERVAL_MS, HOLD_TTL_MS } from './config.js';
import {
  getSeats,
  createHold,
  confirmHold,
  releaseHold,
  expireStaleHolds,
  getInventory,
} from './seatStore.js';
import { addClient, removeClient, clientCount } from './sse.js';

const app = express();
app.use(cors());
app.use(express.json());

// --- Seat map ---
app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getSeats();
    const inventory = await getInventory();
    res.json({ seats, inventory, holdTtlMs: HOLD_TTL_MS });
  } catch (err) {
    console.error('GET /api/seats failed', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// --- Inventory (helper / diagnostics) ---
app.get('/api/inventory', async (req, res) => {
  try {
    res.json(await getInventory());
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// --- Create a hold (atomic, all-or-nothing) ---
app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body || {};
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    const result = await createHold(seatIds, sessionId);
    if (!result.ok) {
      return res.status(409).json({
        error: 'Some seats are no longer available',
        conflicts: result.conflicts,
      });
    }
    res.status(201).json({ hold: result.hold });
  } catch (err) {
    console.error('POST /api/holds failed', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// --- Confirm a hold (idempotent) ---
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  try {
    const result = await confirmHold(holdId);
    if (!result.ok) {
      return res.status(result.status || 409).json({ error: result.error });
    }
    res.json({ booking: result.booking, idempotent: !!result.idempotent });
  } catch (err) {
    console.error('POST /api/holds/:holdId/confirm failed', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// --- Release a hold early ---
app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;
  try {
    const result = await releaseHold(holdId);
    if (!result.ok) {
      return res.status(result.status || 409).json({ error: result.error });
    }
    res.json({ released: result.releasedSeatIds });
  } catch (err) {
    console.error('DELETE /api/holds/:holdId failed', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// --- SSE stream ---
app.get('/api/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  // Send an initial snapshot so a freshly connected client is in sync.
  try {
    const seats = await getSeats();
    res.write(`event: snapshot\ndata: ${JSON.stringify({ seats })}\n\n`);
  } catch {
    /* ignore */
  }

  addClient(res);

  // Heartbeat to keep the connection alive through proxies.
  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {
      /* ignore */
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(res);
  });
});

async function start() {
  await initDb();

  // Periodic sweep to release stale holds even with no traffic.
  setInterval(() => {
    expireStaleHolds().catch((err) =>
      console.error('Sweep failed', err)
    );
  }, SWEEP_INTERVAL_MS);

  app.listen(PORT, () => {
    console.log(`Seat-booking server listening on http://localhost:${PORT}`);
    console.log(`SSE clients connected: ${clientCount()}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
