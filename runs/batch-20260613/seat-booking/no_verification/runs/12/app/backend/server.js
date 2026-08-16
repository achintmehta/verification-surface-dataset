import express from 'express';
import cors from 'cors';
import { PORT, SWEEP_INTERVAL_MS, HOLD_TTL_MS } from './config.js';
import { getDb } from './db.js';
import { addClient, removeClient, clientCount } from './sse.js';
import {
  getSeats,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpiredHolds,
  getInventory,
} from './booking.js';

const app = express();
app.use(cors());
app.use(express.json());

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// --- Seat map -------------------------------------------------------------
app.get(
  '/api/seats',
  asyncHandler(async (req, res) => {
    const seats = await getSeats();
    res.json({ seats, holdTtlMs: HOLD_TTL_MS });
  })
);

// --- Inventory (handy for verification) -----------------------------------
app.get(
  '/api/inventory',
  asyncHandler(async (req, res) => {
    res.json(await getInventory());
  })
);

// --- Create a hold --------------------------------------------------------
app.post(
  '/api/holds',
  asyncHandler(async (req, res) => {
    const { seatIds, sessionId } = req.body || {};
    const hold = await createHold(seatIds, sessionId);
    res.status(201).json(hold);
  })
);

// --- Confirm a hold (idempotent) ------------------------------------------
app.post(
  '/api/holds/:holdId/confirm',
  asyncHandler(async (req, res) => {
    const { holdId } = req.params;
    const { sessionId } = req.body || {};
    const result = await confirmHold(holdId, sessionId);
    res.json(result);
  })
);

// --- Release a hold early -------------------------------------------------
app.delete(
  '/api/holds/:holdId',
  asyncHandler(async (req, res) => {
    const { holdId } = req.params;
    const result = await releaseHold(holdId);
    res.json(result);
  })
);

// --- SSE stream -----------------------------------------------------------
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  const client = addClient(res);

  // Heartbeat to keep the connection alive through proxies.
  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch (_) {
      /* ignore */
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(client);
  });
});

// --- Error handler --------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.statusCode || 500;
  const body = { error: err.message || 'Internal Server Error' };
  if (err.conflicts) body.conflicts = err.conflicts;
  if (status >= 500) console.error(err);
  res.status(status).json(body);
});

async function start() {
  await getDb();

  // Periodic sweep of expired holds.
  setInterval(() => {
    sweepExpiredHolds().catch((e) => console.error('sweep error', e));
  }, SWEEP_INTERVAL_MS).unref();

  app.listen(PORT, () => {
    console.log(`Seat-booking backend listening on http://localhost:${PORT}`);
    console.log(`Hold TTL: ${HOLD_TTL_MS}ms, sweep every ${SWEEP_INTERVAL_MS}ms`);
    console.log(`SSE clients: ${clientCount()}`);
  });
}

start().catch((e) => {
  console.error('Failed to start server', e);
  process.exit(1);
});
