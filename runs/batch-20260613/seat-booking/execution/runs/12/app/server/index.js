import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { initDb } from './db.js';
import {
  getSeats,
  getInventory,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpired,
  setBroadcaster,
} from './seatService.js';
import { addClient, removeClient, broadcastSeats, startHeartbeat, clientCount } from './sse.js';

async function main() {
  await initDb();
  setBroadcaster(broadcastSeats);

  const app = express();
  app.use(cors());
  app.use(express.json());

  // --- Seat map ---
  app.get('/api/seats', async (_req, res) => {
    try {
      const seats = await getSeats();
      const inventory = await getInventory();
      res.json({ seats, inventory });
    } catch (err) {
      console.error('GET /api/seats', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/inventory', async (_req, res) => {
    try {
      res.json(await getInventory());
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // --- Create hold ---
  app.post('/api/holds', async (req, res) => {
    try {
      const { seatIds, sessionId } = req.body || {};
      const result = await createHold(seatIds, sessionId);
      if (result.ok) return res.status(201).json(result.hold);
      return res.status(result.code || 400).json({
        error: result.error,
        conflicts: result.conflicts,
      });
    } catch (err) {
      console.error('POST /api/holds', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // --- Confirm hold ---
  app.post('/api/holds/:holdId/confirm', async (req, res) => {
    try {
      const { sessionId } = req.body || {};
      const result = await confirmHold(req.params.holdId, sessionId);
      if (result.ok) {
        return res.status(200).json({
          booking: result.booking,
          alreadyConfirmed: !!result.alreadyConfirmed,
        });
      }
      return res.status(result.code || 400).json({ error: result.error });
    } catch (err) {
      console.error('POST /api/holds/:id/confirm', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // --- Release hold ---
  app.delete('/api/holds/:holdId', async (req, res) => {
    try {
      const sessionId = req.body?.sessionId || req.query.sessionId;
      const result = await releaseHold(req.params.holdId, sessionId);
      if (result.ok) return res.status(200).json(result);
      return res.status(result.code || 400).json({ error: result.error });
    } catch (err) {
      console.error('DELETE /api/holds/:id', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // --- SSE stream ---
  app.get('/api/stream', (req, res) => {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    const client = addClient(res);
    req.on('close', () => removeClient(client.id));
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, clients: clientCount() });
  });

  startHeartbeat();

  // Periodic sweep to proactively release stale holds.
  setInterval(() => {
    sweepExpired().catch((e) => console.error('sweep error', e));
  }, config.sweepIntervalMs);

  app.listen(config.port, () => {
    console.log(`Seat-booking server listening on http://localhost:${config.port}`);
    console.log(`Seat map: ${config.rows} rows x ${config.seatsPerRow} seats, hold TTL ${config.holdTtlMs}ms`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
