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
  getInventory
} from './booking.js';

const app = express();
app.use(cors());
app.use(express.json());

// --- Seat map -------------------------------------------------------------
app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getSeats();
    res.json({ seats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to load seats' });
  }
});

app.get('/api/inventory', async (req, res) => {
  try {
    res.json(await getInventory());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to load inventory' });
  }
});

// --- Holds ----------------------------------------------------------------
app.post('/api/holds', async (req, res) => {
  try {
    const { seatIds, sessionId } = req.body || {};
    const result = await createHold(seatIds, sessionId);
    if (result.ok) {
      return res.status(201).json({ hold: result.hold });
    }
    if (result.conflicts) {
      return res.status(409).json({
        error: 'some seats are no longer available',
        conflicts: result.conflicts
      });
    }
    return res.status(400).json({ error: result.error || 'bad request' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to create hold' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  try {
    const { holdId } = req.params;
    const { sessionId } = req.body || {};
    const result = await confirmHold(holdId, sessionId);
    if (result.ok) {
      return res.json({
        booking: result.booking,
        alreadyConfirmed: !!result.alreadyConfirmed
      });
    }
    return res.status(result.status || 409).json({ error: result.error });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to confirm hold' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  try {
    const { holdId } = req.params;
    const sessionId = req.body?.sessionId || req.query.sessionId;
    const result = await releaseHold(holdId, sessionId);
    if (result.ok) {
      return res.json({ released: result.released });
    }
    return res.status(result.status || 409).json({ error: result.error });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to release hold' });
  }
});

// --- SSE stream -----------------------------------------------------------
app.get('/api/stream', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  res.write(`event: hello\ndata: ${JSON.stringify({ connected: true })}\n\n`);
  addClient(res);

  // Heartbeat to keep proxies/browsers from closing idle connections.
  const heartbeat = setInterval(() => {
    try {
      res.write(`event: ping\ndata: ${Date.now()}\n\n`);
    } catch (_) {
      clearInterval(heartbeat);
    }
  }, 25_000);

  req.on('close', () => clearInterval(heartbeat));
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, clients: clientCount() });
});

async function start() {
  await getDb(); // initialize schema + seed
  // Periodic sweep releasing stale holds (defense-in-depth alongside lazy expiry).
  setInterval(() => {
    sweepExpired().catch((e) => console.error('sweep error', e));
  }, SWEEP_INTERVAL_MS);

  app.listen(PORT, () => {
    console.log(`seat-booking server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
