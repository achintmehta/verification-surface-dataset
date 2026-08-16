import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './db.js';
import { addClient } from './sse.js';
import {
  getSeats,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpired,
  getInventory,
  getHoldTtlMs,
} from './booking.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

// Ensure DB is ready before serving
await getDb();

// SSE stream
app.get('/api/stream', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(`event: connected\ndata: ${JSON.stringify({ ttlMs: getHoldTtlMs() })}\n\n`);
  addClient(res);

  // keep-alive ping
  const ping = setInterval(() => {
    try {
      res.write(`event: ping\ndata: {}\n\n`);
    } catch (e) {
      clearInterval(ping);
    }
  }, 25000);
  req.on('close', () => clearInterval(ping));
});

app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getSeats();
    const inventory = await getInventory();
    res.json({ seats, inventory, ttlMs: getHoldTtlMs() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/holds', async (req, res) => {
  try {
    const { seatIds, sessionId } = req.body || {};
    const result = await createHold(seatIds, sessionId);
    if (!result.ok) {
      if (result.conflicts) {
        return res.status(409).json({ error: result.error || 'seats unavailable', conflicts: result.conflicts });
      }
      return res.status(400).json({ error: result.error || 'bad request' });
    }
    res.status(201).json({ hold: result.hold });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  try {
    const result = await confirmHold(req.params.holdId);
    if (!result.ok) {
      return res.status(result.status || 409).json({ error: result.error || 'confirm failed' });
    }
    res.json({ booking: result.booking, idempotent: !!result.idempotent });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  try {
    const result = await releaseHold(req.params.holdId);
    if (!result.ok) {
      return res.status(result.status || 409).json({ error: result.error || 'release failed' });
    }
    res.json({ released: true, seatIds: result.seatIds });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal error' });
  }
});

// Serve built frontend if present
const distDir = path.join(__dirname, '..', 'dist');
app.use(express.static(distDir));

// Periodic sweep for stale holds
setInterval(() => {
  sweepExpired().catch((e) => console.error('sweep error', e));
}, 5000);

app.listen(PORT, () => {
  console.log(`Seat booking server listening on http://localhost:${PORT}`);
});
