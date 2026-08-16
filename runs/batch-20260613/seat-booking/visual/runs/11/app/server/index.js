import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { getDb } from './db.js';
import {
  setBroadcaster,
  readSeats,
  inventory,
  createHold,
  confirmHold,
  releaseHold,
  sweep,
} from './bookings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3001', 10);

const app = express();
app.use(cors());
app.use(express.json());

// ---- SSE infrastructure ----
const clients = new Set();

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}
setBroadcaster(broadcast);

app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(`retry: 3000\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  clients.add(res);

  const keepAlive = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {
      /* ignore */
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
});

// ---- REST API ----
app.get('/api/seats', async (req, res) => {
  try {
    const seats = await readSeats();
    const counts = { available: 0, held: 0, booked: 0, total: seats.length };
    for (const s of seats) counts[s.status]++;
    res.json({ seats, inventory: counts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/api/inventory', async (req, res) => {
  try {
    res.json(await inventory());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.post('/api/holds', async (req, res) => {
  try {
    const { seatIds, sessionId } = req.body || {};
    if (!Array.isArray(seatIds) || seatIds.length === 0) {
      return res.status(400).json({ error: 'seatIds required' });
    }
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId required' });
    }
    // de-dup
    const unique = [...new Set(seatIds.map(String))];
    const result = await createHold(unique, sessionId);
    if (!result.ok) {
      return res.status(409).json({ error: 'seats_unavailable', conflicts: result.conflicts });
    }
    res.status(201).json({ hold: result.hold, seats: result.seats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  try {
    const { holdId } = req.params;
    const { sessionId } = req.body || {};
    const result = await confirmHold(holdId, sessionId);
    if (!result.ok) {
      const code = result.error === 'unknown_hold' ? 404 : 409;
      return res.status(code).json({ error: result.error });
    }
    res.json({ booking: result.booking, seats: result.seats, idempotent: result.idempotent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  try {
    const { holdId } = req.params;
    const sessionId = req.body?.sessionId || req.query?.sessionId;
    const result = await releaseHold(holdId, sessionId);
    if (!result.ok) {
      const code = result.error === 'unknown_hold' ? 404 : 409;
      return res.status(code).json({ error: result.error });
    }
    res.json({ released: result.seatIds });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ---- Serve built frontend if present ----
const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

async function start() {
  await getDb();
  // Periodic sweep every 10s to proactively release stale holds.
  setInterval(() => {
    sweep().catch((e) => console.error('sweep error', e));
  }, 10000);

  app.listen(PORT, () => {
    console.log(`Seat-booking server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
