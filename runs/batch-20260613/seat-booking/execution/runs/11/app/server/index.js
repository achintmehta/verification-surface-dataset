import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { getDb } from './db.js';
import { addClient, clientCount } from './sse.js';
import {
  getSeats,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpiredHolds,
  getInventory,
} from './booking.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

// --- API routes ---

app.get('/api/seats', async (_req, res, next) => {
  try {
    const seats = await getSeats();
    res.json({ seats });
  } catch (err) {
    next(err);
  }
});

app.get('/api/inventory', async (_req, res, next) => {
  try {
    res.json(await getInventory());
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const { seatIds, sessionId } = req.body || {};
    const hold = await createHold(seatIds, sessionId);
    res.status(201).json(hold);
  } catch (err) {
    if (err.status === 409 && err.conflicts) {
      return res.status(409).json({ error: err.message, conflicts: err.conflicts });
    }
    next(err);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const { sessionId } = req.body || {};
    const booking = await confirmHold(req.params.holdId, sessionId);
    res.json(booking);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const sessionId = req.body?.sessionId || req.query.sessionId;
    const result = await releaseHold(req.params.holdId, sessionId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// --- SSE endpoint ---
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write(`event: connected\ndata: ${JSON.stringify({ clients: clientCount() + 1 })}\n\n`);
  addClient(res);

  // Heartbeat to keep proxies from closing the connection.
  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, 15000);
  req.on('close', () => clearInterval(heartbeat));
});

// --- Serve built frontend if present ---
const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// --- Error handler ---
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Internal Server Error' });
});

async function start() {
  await getDb();
  // Periodic sweep to release abandoned holds even with no readers.
  setInterval(() => {
    sweepExpiredHolds().catch((e) => console.error('sweep error', e));
  }, 5000).unref();

  app.listen(PORT, () => {
    console.log(`Seat-booking server listening on http://localhost:${PORT}`);
  });
}

start();
