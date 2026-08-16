import express from 'express';
import cors from 'cors';
import { PORT, SWEEP_INTERVAL_MS } from './config.js';
import { initDb } from './db.js';
import { addClient } from './sse.js';
import {
  BookingError,
  createHold,
  confirmHold,
  releaseHold,
  getHold,
  getSeatMap,
  getInventory,
  sweepExpiredHolds,
} from './booking.js';

const app = express();
app.use(cors());
app.use(express.json());

function sendError(res, err) {
  if (err instanceof BookingError) {
    return res.status(err.status).json({
      error: err.code,
      message: err.message,
      ...err.details,
    });
  }
  // eslint-disable-next-line no-console
  console.error(err);
  return res.status(500).json({ error: 'internal_error', message: 'Internal error' });
}

// --- Seat map ------------------------------------------------------------
app.get('/api/seats', async (_req, res) => {
  try {
    const seats = await getSeatMap();
    res.json({ seats });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/inventory', async (_req, res) => {
  try {
    const inventory = await getInventory();
    res.json(inventory);
  } catch (err) {
    sendError(res, err);
  }
});

// --- Holds ---------------------------------------------------------------
app.post('/api/holds', async (req, res) => {
  try {
    const { seatIds, sessionId } = req.body || {};
    const hold = await createHold(seatIds, sessionId);
    res.status(201).json(hold);
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/holds/:holdId', async (req, res) => {
  try {
    const hold = await getHold(req.params.holdId);
    res.json(hold);
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    const result = await confirmHold(req.params.holdId, sessionId);
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  try {
    const sessionId = req.body?.sessionId ?? req.query.sessionId;
    const result = await releaseHold(req.params.holdId, sessionId);
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

// --- SSE stream ----------------------------------------------------------
app.get('/api/stream', (req, res) => {
  addClient(req, res);
});

// --- Bootstrap -----------------------------------------------------------
async function start() {
  await initDb();

  // Periodic sweep to release stale holds even with no read traffic.
  const sweep = setInterval(() => {
    sweepExpiredHolds().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Sweep failed:', err);
    });
  }, SWEEP_INTERVAL_MS);
  sweep.unref?.();

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Seat-booking server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start server:', err);
  process.exit(1);
});
