import express from 'express';
import cors from 'cors';
import { PORT, HOLD_TTL_MS, SWEEP_INTERVAL_MS } from './config.js';
import { initDb } from './db.js';
import {
  getSeats,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpired,
  getInventory,
  setBroadcaster,
} from './seatService.js';
import { addClient, removeClient, broadcast } from './sse.js';

async function main() {
  await initDb();
  setBroadcaster(broadcast);

  const app = express();
  app.use(cors());
  app.use(express.json());

  // ---- Seat map ----
  app.get('/api/seats', async (_req, res) => {
    try {
      const seats = await getSeats();
      res.json({ seats, holdTtlMs: HOLD_TTL_MS });
    } catch (err) {
      console.error('GET /api/seats failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  // ---- Inventory (diagnostics / acceptance) ----
  app.get('/api/inventory', async (_req, res) => {
    try {
      res.json(await getInventory());
    } catch (err) {
      console.error('GET /api/inventory failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  // ---- Create hold ----
  app.post('/api/holds', async (req, res) => {
    const { seatIds, sessionId } = req.body || {};
    if (!Array.isArray(seatIds) || seatIds.length === 0) {
      return res.status(400).json({ error: 'seatIds_required' });
    }
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId_required' });
    }
    // De-duplicate seat ids.
    const unique = [...new Set(seatIds)];
    try {
      const result = await createHold(unique, sessionId);
      if (!result.ok) {
        return res
          .status(409)
          .json({ error: 'seats_unavailable', conflicts: result.conflicts });
      }
      return res.status(201).json({ hold: result.hold });
    } catch (err) {
      console.error('POST /api/holds failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  // ---- Confirm hold (idempotent) ----
  app.post('/api/holds/:holdId/confirm', async (req, res) => {
    const { holdId } = req.params;
    const { sessionId } = req.body || {};
    try {
      const result = await confirmHold(holdId, sessionId);
      if (!result.ok) {
        const status = result.reason === 'unknown_hold' ? 404 : 409;
        return res.status(status).json({ error: result.reason });
      }
      return res.json({ booking: result.booking, idempotent: !!result.idempotent });
    } catch (err) {
      console.error('POST /api/holds/:holdId/confirm failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  // ---- Release hold ----
  app.delete('/api/holds/:holdId', async (req, res) => {
    const { holdId } = req.params;
    const sessionId = (req.body && req.body.sessionId) || req.query.sessionId;
    try {
      const result = await releaseHold(holdId, sessionId);
      if (!result.ok) {
        const status = result.reason === 'unknown_hold' ? 404 : 409;
        return res.status(status).json({ error: result.reason });
      }
      return res.json({ released: result.seatIds });
    } catch (err) {
      console.error('DELETE /api/holds/:holdId failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  // ---- SSE stream ----
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
        res.write(': ping\n\n');
      } catch (_e) {
        clearInterval(heartbeat);
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      removeClient(client);
    });
  });

  // Periodic sweep to release stale holds even without traffic.
  setInterval(() => {
    sweepExpired().catch((err) => console.error('sweep failed', err));
  }, SWEEP_INTERVAL_MS);

  app.listen(PORT, () => {
    console.log(`Seat-booking server listening on http://localhost:${PORT}`);
    console.log(`Hold TTL: ${HOLD_TTL_MS}ms, sweep every ${SWEEP_INTERVAL_MS}ms`);
  });
}

main().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
