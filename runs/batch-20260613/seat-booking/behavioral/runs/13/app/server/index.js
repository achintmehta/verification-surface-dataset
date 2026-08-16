// Express HTTP server exposing the seat-booking API and SSE stream.

import express from 'express';
import cors from 'cors';

import { PORT, DATA_DIR, SWEEP_INTERVAL_MS, HOLD_TTL_MS } from './config.js';
import { createDb } from './db.js';
import { createSSEHub } from './sse.js';
import {
  initSchema,
  getSeats,
  getSeatStates,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpired,
  getInventory,
  ConflictError,
  HoldError,
} from './booking.js';

export async function createServer({ dataDir = DATA_DIR } = {}) {
  const db = await createDb(dataDir);
  await initSchema(db);

  const sse = createSSEHub();
  const app = express();
  app.use(cors());
  app.use(express.json());

  // --- SSE stream -----------------------------------------------------------
  app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ ttl: HOLD_TTL_MS })}\n\n`);
    sse.addClient(res);

    // Heartbeat to keep the connection alive through proxies.
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 25000);
    req.on('close', () => clearInterval(heartbeat));
  });

  // --- Seat map -------------------------------------------------------------
  app.get('/api/seats', async (req, res) => {
    try {
      const { seats, released } = await getSeats(db);
      if (released.length > 0) {
        const states = await getSeatStates(db, released);
        sse.broadcastSeatUpdate(states, released);
      }
      const inventory = await getInventory(db);
      res.json({ seats, ttlMs: HOLD_TTL_MS, inventory });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Create a hold --------------------------------------------------------
  app.post('/api/holds', async (req, res) => {
    const { seatIds, sessionId } = req.body || {};
    try {
      const { hold, released } = await createHold(db, seatIds, sessionId);

      // Broadcast freed-by-expiry seats and newly-held seats.
      const affected = [...new Set([...(released || []), ...hold.seatIds])];
      const states = await getSeatStates(db, affected);
      sse.broadcastSeatUpdate(states, released);

      res.status(201).json({ hold });
    } catch (err) {
      if (err instanceof ConflictError) {
        // Refresh broadcast for any expired releases that may have happened.
        res
          .status(409)
          .json({ error: 'seats_unavailable', conflicts: err.conflicts });
      } else if (err instanceof HoldError) {
        res.status(400).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message });
      }
    }
  });

  // --- Confirm a hold -------------------------------------------------------
  app.post('/api/holds/:holdId/confirm', async (req, res) => {
    const { holdId } = req.params;
    try {
      const { booking, released } = await confirmHold(db, holdId);

      const affected = [...new Set([...(released || []), ...booking.seatIds])];
      const states = await getSeatStates(db, affected);
      sse.broadcastSeatUpdate(states, released);

      res.json({ booking });
    } catch (err) {
      if (err instanceof HoldError) {
        // If the hold expired, its seats were just released; broadcast that.
        res.status(409).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message });
      }
    }
  });

  // --- Release a hold early -------------------------------------------------
  app.delete('/api/holds/:holdId', async (req, res) => {
    const { holdId } = req.params;
    try {
      const { released } = await releaseHold(db, holdId);
      if (released.length > 0) {
        const states = await getSeatStates(db, released);
        sse.broadcastSeatUpdate(states, released);
      }
      res.json({ released });
    } catch (err) {
      if (err instanceof HoldError) {
        res.status(404).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message });
      }
    }
  });

  // --- Inventory (debug / acceptance) --------------------------------------
  app.get('/api/inventory', async (req, res) => {
    try {
      res.json(await getInventory(db));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Periodic sweep -------------------------------------------------------
  const sweepTimer = setInterval(async () => {
    try {
      const released = await sweepExpired(db);
      if (released.length > 0) {
        const states = await getSeatStates(db, released);
        sse.broadcastSeatUpdate(states, released);
      }
    } catch {
      // ignore sweep errors
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  async function stop() {
    clearInterval(sweepTimer);
    await db.close();
  }

  return { app, db, sse, stop };
}

// Start the server unless imported (e.g. by tests).
import { pathToFileURL } from 'node:url';
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly || process.env.START_SERVER === '1') {
  createServer().then(({ app }) => {
    app.listen(PORT, () => {
      console.log(`Seat-booking server listening on http://localhost:${PORT}`);
    });
  });
}
