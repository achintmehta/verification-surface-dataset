import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { addClient, removeClient } from './sse.js';
import {
  getSeats,
  createHold,
  confirmHold,
  releaseHold,
  sweep,
  inventory,
  HOLD_TTL_MS,
} from './seats.js';

const PORT = process.env.PORT || 3001;

async function main() {
  await initDb();

  const app = express();
  app.use(cors());
  app.use(express.json());

  // Effective seat map.
  app.get('/api/seats', async (req, res) => {
    try {
      const seats = await getSeats();
      res.json({ seats, ttlMs: HOLD_TTL_MS });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Inventory accounting (handy for verification).
  app.get('/api/inventory', async (req, res) => {
    try {
      res.json(await inventory());
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Create a hold (atomic, all-or-nothing).
  app.post('/api/holds', async (req, res) => {
    try {
      const { seatIds, sessionId } = req.body || {};
      const result = await createHold(seatIds, sessionId);
      if (!result.ok) {
        return res.status(result.status || 409).json({
          error: result.error,
          conflicts: result.conflicts || [],
        });
      }
      res.status(201).json(result.hold);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Confirm a hold (idempotent).
  app.post('/api/holds/:holdId/confirm', async (req, res) => {
    try {
      const result = await confirmHold(req.params.holdId);
      if (!result.ok) {
        return res.status(result.status || 409).json({ error: result.error });
      }
      res.json(result.booking);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Release a hold early.
  app.delete('/api/holds/:holdId', async (req, res) => {
    try {
      const result = await releaseHold(req.params.holdId);
      if (!result.ok) {
        return res.status(result.status || 409).json({ error: result.error });
      }
      res.json({ released: result.released });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // SSE stream of seat status transitions.
  app.get('/api/stream', async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    // Send initial full snapshot so a freshly-connected client is in sync.
    try {
      const seats = await getSeats();
      res.write(`event: snapshot\ndata: ${JSON.stringify({ seats })}\n\n`);
    } catch {}

    addClient(res);

    const keepAlive = setInterval(() => {
      try { res.write(': keep-alive\n\n'); } catch {}
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAlive);
      removeClient(res);
    });
  });

  // Periodic sweep to release abandoned holds.
  setInterval(() => {
    sweep().catch((err) => console.error('sweep error', err));
  }, 5000);

  app.listen(PORT, () => {
    console.log(`Seat-booking server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
