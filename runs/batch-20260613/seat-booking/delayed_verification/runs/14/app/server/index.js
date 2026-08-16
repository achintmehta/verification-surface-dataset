import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { initDb } from './db.js';
import {
  getSeats,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpired,
  getInventory,
} from './seats.js';
import { addClient, broadcast, clientCount } from './sse.js';

const app = express();
app.use(cors());
app.use(express.json());

// --- Seat map -------------------------------------------------------------
// Returns every seat with its current effective status (expired holds are
// reported as available).
app.get('/api/seats', async (_req, res) => {
  try {
    const seats = await getSeats();
    res.json({ seats });
  } catch (e) {
    console.error('GET /api/seats failed', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// --- Inventory (diagnostics) ---------------------------------------------
app.get('/api/inventory', async (_req, res) => {
  try {
    res.json(await getInventory());
  } catch (e) {
    res.status(500).json({ error: 'internal_error' });
  }
});

// --- Create hold ----------------------------------------------------------
app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body || {};
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds_required' });
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return res.status(400).json({ error: 'sessionId_required' });
  }
  try {
    const result = await createHold(seatIds, sessionId);
    if (!result.ok) {
      return res.status(409).json({ error: 'seats_unavailable', conflicts: result.conflicts });
    }
    return res.status(201).json({ hold: result.hold });
  } catch (e) {
    console.error('POST /api/holds failed', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// --- Confirm hold ---------------------------------------------------------
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  try {
    const result = await confirmHold(holdId);
    if (!result.ok) {
      const codeMap = {
        unknown_hold: 404,
        hold_expired: 410,
        hold_released: 410,
        no_seats: 409,
      };
      const status = codeMap[result.error] || 400;
      return res.status(status).json({ error: result.error });
    }
    return res.json({ booking: result.booking, idempotent: !!result.idempotent });
  } catch (e) {
    console.error('POST /api/holds/:holdId/confirm failed', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// --- Release hold ---------------------------------------------------------
app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;
  try {
    const result = await releaseHold(holdId);
    if (!result.ok) {
      const codeMap = { unknown_hold: 404, already_confirmed: 409 };
      const status = codeMap[result.error] || 400;
      return res.status(status).json({ error: result.error });
    }
    return res.json({ released: result.released.map((s) => s.id) });
  } catch (e) {
    console.error('DELETE /api/holds/:holdId failed', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// --- SSE stream -----------------------------------------------------------
app.get('/api/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  addClient(res);

  // Send an initial snapshot so a freshly connected client is immediately in
  // sync without waiting for the next transition.
  try {
    const seats = await getSeats();
    res.write(`event: snapshot\ndata: ${JSON.stringify({ seats })}\n\n`);
  } catch (_e) {
    /* ignore */
  }

  // Heartbeat keeps proxies/connections alive.
  const heartbeat = setInterval(() => {
    try {
      res.write(`event: ping\ndata: ${Date.now()}\n\n`);
    } catch (_e) {
      /* ignore */
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
  });
});

async function start() {
  await initDb();

  // Periodic sweep to release abandoned holds even with no read traffic.
  setInterval(() => {
    sweepExpired().catch((e) => console.error('sweep failed', e));
  }, config.sweepIntervalMs);

  app.listen(config.port, () => {
    console.log(`Seat-booking server listening on http://localhost:${config.port}`);
    console.log(`Connected SSE clients: ${clientCount()}`);
  });
}

start().catch((e) => {
  console.error('Failed to start server', e);
  process.exit(1);
});

export { app };
