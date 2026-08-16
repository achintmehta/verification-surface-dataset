import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import { initDb, getDb, TOTAL_SEATS } from './db.js';
import {
  getSeats,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpired,
  getInventory,
  HOLD_TTL_MS,
} from './bookings.js';
import { addClient, broadcast, broadcastSeatUpdates } from './sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

/** Helper: fetch the given seat ids and broadcast their current statuses. */
async function broadcastSeats(seatIds) {
  if (!seatIds || seatIds.length === 0) return;
  const unique = [...new Set(seatIds)];
  const db = getDb();
  const res = await db.query(
    `SELECT id, status, hold_id, hold_expires_at, booked_by
       FROM seats WHERE id = ANY($1::text[])`,
    [unique]
  );
  broadcastSeatUpdates(
    res.rows.map((r) => ({
      id: r.id,
      status: r.status,
      holdId: r.hold_id,
      holdExpiresAt: r.hold_expires_at
        ? new Date(r.hold_expires_at).toISOString()
        : null,
      bookedBy: r.booked_by,
    }))
  );
}

// --- API ---

app.get('/api/seats', async (req, res, next) => {
  try {
    const { seats, released } = await getSeats();
    if (released.length) await broadcastSeats(released);
    res.json({ seats, total: TOTAL_SEATS, holdTtlMs: HOLD_TTL_MS });
  } catch (err) {
    next(err);
  }
});

app.get('/api/inventory', async (req, res, next) => {
  try {
    const counts = await getInventory();
    res.json({ ...counts, total: TOTAL_SEATS });
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const { seatIds, sessionId } = req.body || {};
    if (!Array.isArray(seatIds) || seatIds.length === 0) {
      return res.status(400).json({ error: 'seatIds must be a non-empty array' });
    }
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    const result = await createHold(seatIds, sessionId);

    // Broadcast any seats freed by the lazy expiry sweep.
    if (result.released && result.released.length) {
      await broadcastSeats(result.released);
    }

    if (!result.ok) {
      return res.status(409).json({
        error: 'seats_unavailable',
        conflicts: result.conflicts,
      });
    }

    await broadcastSeats(result.seatIds);
    res.status(201).json({ hold: result.hold });
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const { holdId } = req.params;
    const result = await confirmHold(holdId);

    if (!result.ok) {
      const status = result.error === 'not_found' ? 404 : 409;
      return res.status(status).json({ error: result.error });
    }

    if (result.seatIds && result.seatIds.length) {
      await broadcastSeats(result.seatIds);
    }
    res.json({ booking: result.booking, alreadyConfirmed: !!result.alreadyConfirmed });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const { holdId } = req.params;
    const result = await releaseHold(holdId);

    if (!result.ok) {
      const status = result.error === 'not_found' ? 404 : 409;
      return res.status(status).json({ error: result.error });
    }

    if (result.seatIds && result.seatIds.length) {
      await broadcastSeats(result.seatIds);
    }
    res.json({ released: result.seatIds });
  } catch (err) {
    next(err);
  }
});

// SSE stream
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  addClient(res);

  // Keep-alive ping.
  const ping = setInterval(() => {
    try {
      res.write(`event: ping\ndata: ${Date.now()}\n\n`);
    } catch {
      clearInterval(ping);
    }
  }, 25_000);
  res.on('close', () => clearInterval(ping));
});

// Serve built frontend if present.
const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// Error handler.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

async function start() {
  await initDb();

  // Periodic sweep: release stale holds and broadcast.
  setInterval(async () => {
    try {
      const released = await sweepExpired();
      if (released.length) await broadcastSeats(released);
    } catch (err) {
      console.error('sweep error', err);
    }
  }, 5_000);

  app.listen(PORT, () => {
    console.log(`Seat-booking server listening on http://localhost:${PORT}`);
  });
}

start();
