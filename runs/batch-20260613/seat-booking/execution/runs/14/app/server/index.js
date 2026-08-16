import express from 'express';
import cors from 'cors';
import { PORT, SWEEP_INTERVAL_MS, HOLD_TTL_MS, ROW_LABELS, SEATS_PER_ROW } from './config.js';
import { initDb } from './db.js';
import {
  getSeats,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpiredHolds,
  getInventory,
} from './booking.js';
import { addClient, broadcast, clientCount } from './sse.js';

const app = express();
app.use(cors());
app.use(express.json());

// --- Seat map ---------------------------------------------------------------
app.get('/api/seats', async (req, res, next) => {
  try {
    const seats = await getSeats();
    res.json({
      seats,
      meta: {
        rows: ROW_LABELS,
        seatsPerRow: SEATS_PER_ROW,
        holdTtlMs: HOLD_TTL_MS,
        total: seats.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/inventory', async (req, res, next) => {
  try {
    res.json(await getInventory());
  } catch (err) {
    next(err);
  }
});

// --- Holds ------------------------------------------------------------------
app.post('/api/holds', async (req, res, next) => {
  try {
    const { seatIds, sessionId } = req.body || {};
    const result = await createHold(seatIds, sessionId);
    if (result.ok) {
      return res.status(201).json({ hold: result.hold });
    }
    if (result.code === 'CONFLICT') {
      return res.status(409).json({
        error: 'SEATS_UNAVAILABLE',
        message: 'One or more requested seats are no longer available.',
        conflicts: result.conflicts,
        missing: result.missing,
      });
    }
    return res.status(400).json({ error: result.code, message: result.message });
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const result = await confirmHold(req.params.holdId);
    if (result.ok) {
      return res.status(200).json({
        booking: result.booking,
        idempotent: !!result.idempotent,
      });
    }
    const statusByCode = {
      NOT_FOUND: 404,
      HOLD_EXPIRED: 410,
      HOLD_INACTIVE: 409,
      BAD_REQUEST: 400,
    };
    return res
      .status(statusByCode[result.code] || 400)
      .json({ error: result.code, message: result.message });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const result = await releaseHold(req.params.holdId);
    if (result.ok) {
      return res.status(200).json({ releasedSeats: result.releasedSeats });
    }
    const statusByCode = {
      NOT_FOUND: 404,
      ALREADY_CONFIRMED: 409,
      BAD_REQUEST: 400,
    };
    return res
      .status(statusByCode[result.code] || 400)
      .json({ error: result.code, message: result.message });
  } catch (err) {
    next(err);
  }
});

// --- SSE --------------------------------------------------------------------
app.get('/api/stream', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  addClient(res);
  res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);

  // Send a fresh snapshot so the new client starts in sync.
  try {
    const seats = await getSeats();
    res.write(`event: snapshot\ndata: ${JSON.stringify({ seats })}\n\n`);
  } catch {
    /* ignore */
  }

  // Heartbeat keeps the connection alive through proxies.
  const heartbeat = setInterval(() => {
    try {
      res.write(`event: ping\ndata: ${Date.now()}\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, 25000);

  req.on('close', () => clearInterval(heartbeat));
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, sseClients: clientCount() });
});

// --- Error handler ----------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'INTERNAL', message: String(err && err.message || err) });
});

async function main() {
  await initDb();

  // Periodic sweep releases stale holds even with no traffic.
  setInterval(() => {
    sweepExpiredHolds().catch((e) => console.error('[sweep]', e));
  }, SWEEP_INTERVAL_MS);

  app.listen(PORT, () => {
    console.log(`Seat-booking server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
