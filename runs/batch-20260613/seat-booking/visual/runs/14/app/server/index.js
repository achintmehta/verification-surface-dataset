import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb } from './db.js';
import { addClient } from './sse.js';
import {
  getAllSeats,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpired,
  getInventory,
  HOLD_TTL_MS,
} from './seatService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

async function main() {
  await initDb();

  const app = express();
  app.use(cors());
  app.use(express.json());

  // --- Seat map ---
  app.get('/api/seats', async (_req, res) => {
    try {
      const seats = await getAllSeats();
      res.json({ seats, ttlMs: HOLD_TTL_MS });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/inventory', async (_req, res) => {
    try {
      res.json(await getInventory());
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // --- Create a hold (all-or-nothing) ---
  app.post('/api/holds', async (req, res) => {
    const { seatIds, sessionId } = req.body || {};
    if (!Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
      return res
        .status(400)
        .json({ error: 'seatIds (non-empty array) and sessionId are required' });
    }
    try {
      const result = await createHold(seatIds, sessionId);
      if (!result.ok) {
        return res
          .status(409)
          .json({ error: 'Some seats are unavailable', conflicts: result.conflicts });
      }
      res.status(201).json({ hold: result.hold });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // --- Confirm a hold (idempotent) ---
  app.post('/api/holds/:holdId/confirm', async (req, res) => {
    try {
      const result = await confirmHold(req.params.holdId);
      if (!result.ok) {
        return res.status(409).json({ error: result.error });
      }
      res.json({ booking: result.booking, idempotent: !!result.idempotent });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // --- Release a hold early ---
  app.delete('/api/holds/:holdId', async (req, res) => {
    try {
      const result = await releaseHold(req.params.holdId);
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // --- SSE stream ---
  app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: connected\ndata: {"ok":true}\n\n`);
    addClient(res);

    // Heartbeat to keep the connection alive through proxies.
    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch {
        clearInterval(heartbeat);
      }
    }, 25000);
    req.on('close', () => clearInterval(heartbeat));
  });

  // Serve built frontend if present.
  const distDir = path.join(__dirname, '..', 'dist');
  app.use(express.static(distDir));

  app.listen(PORT, () => {
    console.log(`Seat-booking server listening on http://localhost:${PORT}`);
  });

  // Periodic sweep to release abandoned holds even with no read traffic.
  setInterval(() => {
    sweepExpired().catch((e) => console.error('sweep error', e));
  }, 5000);
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
