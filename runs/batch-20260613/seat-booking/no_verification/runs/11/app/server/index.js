import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { addClient, removeClient } from './sse.js';
import {
  getSeats,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpired,
  getInventory,
  ConflictError,
  BadRequestError,
} from './seats.js';

const PORT = process.env.PORT || 3001;
const SWEEP_INTERVAL_MS = 5000;

async function main() {
  await initDb();

  const app = express();
  app.use(cors());
  app.use(express.json());

  // --- Seat map ---------------------------------------------------------
  app.get('/api/seats', async (req, res) => {
    try {
      const seats = await getSeats();
      res.json({ seats });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/inventory', async (req, res) => {
    try {
      res.json(await getInventory());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Holds ------------------------------------------------------------
  app.post('/api/holds', async (req, res) => {
    const { seatIds, sessionId } = req.body || {};
    try {
      const hold = await createHold(seatIds, sessionId);
      res.status(201).json(hold);
    } catch (err) {
      if (err instanceof ConflictError) {
        return res
          .status(409)
          .json({ error: 'seats_unavailable', conflicts: err.conflicts });
      }
      if (err instanceof BadRequestError) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/holds/:holdId/confirm', async (req, res) => {
    const { holdId } = req.params;
    const { sessionId } = req.body || {};
    try {
      const result = await confirmHold(holdId, sessionId);
      res.json(result);
    } catch (err) {
      if (err instanceof BadRequestError) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/holds/:holdId', async (req, res) => {
    const { holdId } = req.params;
    try {
      const result = await releaseHold(holdId);
      res.json(result);
    } catch (err) {
      if (err instanceof BadRequestError) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // --- SSE stream -------------------------------------------------------
  app.get('/api/stream', async (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    // Send an initial snapshot so the client is immediately in sync.
    try {
      const seats = await getSeats();
      res.write(`event: snapshot\ndata: ${JSON.stringify({ seats })}\n\n`);
    } catch {
      res.write(`event: snapshot\ndata: ${JSON.stringify({ seats: [] })}\n\n`);
    }

    addClient(res);

    // Heartbeat to keep the connection alive through proxies.
    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch {
        clearInterval(heartbeat);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      removeClient(res);
      res.end();
    });
  });

  // Periodic sweep to release stale holds even with no traffic.
  setInterval(() => {
    sweepExpired().catch((err) => console.error('sweep error:', err.message));
  }, SWEEP_INTERVAL_MS);

  app.listen(PORT, () => {
    console.log(`Seat-booking server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
