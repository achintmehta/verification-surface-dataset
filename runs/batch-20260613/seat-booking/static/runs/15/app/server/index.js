import express from 'express';
import cors from 'cors';
import { PORT, SWEEP_INTERVAL_MS } from './config.js';
import { getDb } from './db.js';
import { addClient, clientCount } from './sse.js';
import {
  getSeats,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpired,
  getInventory,
} from './seats.js';

const app = express();
app.use(cors());
app.use(express.json());

// Wrap async handlers to forward errors to the error middleware.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- Seat map -------------------------------------------------------------

app.get(
  '/api/seats',
  wrap(async (_req, res) => {
    const seats = await getSeats();
    res.json({ seats });
  })
);

app.get(
  '/api/inventory',
  wrap(async (_req, res) => {
    res.json(await getInventory());
  })
);

// ---- Holds ----------------------------------------------------------------

app.post(
  '/api/holds',
  wrap(async (req, res) => {
    const { seatIds, sessionId } = req.body || {};
    const hold = await createHold(seatIds, sessionId);
    res.status(201).json(hold);
  })
);

app.post(
  '/api/holds/:holdId/confirm',
  wrap(async (req, res) => {
    const result = await confirmHold(req.params.holdId);
    res.json(result);
  })
);

app.delete(
  '/api/holds/:holdId',
  wrap(async (req, res) => {
    const result = await releaseHold(req.params.holdId);
    res.json(result);
  })
);

// ---- SSE stream -----------------------------------------------------------

app.get('/api/stream', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  // Initial snapshot so a freshly connected client is in sync immediately.
  try {
    const seats = await getSeats();
    res.write(`event: snapshot\ndata: ${JSON.stringify({ seats })}\n\n`);
  } catch {
    // ignore snapshot failure; client can still fetch /api/seats
  }

  // Register and keep alive with periodic comments.
  addClient(res);
  res.write(': connected\n\n');
  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(keepAlive);
    }
  }, 25_000);
  req.on('close', () => clearInterval(keepAlive));
});

// ---- Error handling -------------------------------------------------------

app.use((err, _req, res, _next) => {
  const status = err.statusCode || 500;
  const body = { error: err.message || 'Internal Server Error' };
  if (err.conflicts) body.conflicts = err.conflicts;
  if (status >= 500) console.error(err);
  res.status(status).json(body);
});

// ---- Startup --------------------------------------------------------------

async function start() {
  await getDb(); // initialize schema + seed
  // Periodic sweep to release abandoned holds even with no readers.
  setInterval(() => {
    sweepExpired().catch((e) => console.error('sweep error', e));
  }, SWEEP_INTERVAL_MS);

  app.listen(PORT, () => {
    console.log(`Seat-booking server listening on http://localhost:${PORT}`);
    console.log(`SSE clients connected: ${clientCount()}`);
  });
}

start().catch((e) => {
  console.error('Failed to start server', e);
  process.exit(1);
});
