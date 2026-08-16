import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { initDb } from './db.js';
import {
  listSeats,
  inventory,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpired,
  SeatError,
} from './seatService.js';
import { addClient, removeClient, broadcastSeatChanges, broadcast, clientCount } from './sse.js';

export async function createServer() {
  await initDb();

  const app = express();
  app.use(cors());
  app.use(express.json());

  // ---- Seat map -----------------------------------------------------------
  app.get('/api/seats', async (req, res, next) => {
    try {
      const { seats, released } = await listSeats();
      broadcastSeatChanges(released, 'released');
      res.json({ seats, ttlMs: config.holdTtlMs });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/inventory', async (req, res, next) => {
    try {
      const { counts, released } = await inventory();
      broadcastSeatChanges(released, 'released');
      res.json(counts);
    } catch (err) {
      next(err);
    }
  });

  // ---- Holds --------------------------------------------------------------
  app.post('/api/holds', async (req, res, next) => {
    try {
      const { seatIds, sessionId } = req.body || {};
      const { hold, seats, released } = await createHold(seatIds, sessionId);
      broadcastSeatChanges(released, 'released');
      broadcastSeatChanges(seats, 'held');
      res.status(201).json({ hold, seats });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
    try {
      const { sessionId } = req.body || {};
      const result = await confirmHold(req.params.holdId, sessionId);
      broadcastSeatChanges(result.released, 'released');
      if (!result.idempotent) {
        broadcastSeatChanges(result.seats, 'booked');
      }
      res.json({ booking: result.booking, seats: result.seats, idempotent: !!result.idempotent });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/holds/:holdId', async (req, res, next) => {
    try {
      const sessionId = req.body?.sessionId || req.query.sessionId;
      const result = await releaseHold(req.params.holdId, sessionId);
      broadcastSeatChanges(result.released, 'released');
      broadcastSeatChanges(result.seats, 'released');
      res.json({ released: result.seats, alreadyGone: !!result.alreadyGone });
    } catch (err) {
      next(err);
    }
  });

  // ---- SSE stream ---------------------------------------------------------
  app.get('/api/stream', async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);

    // Send initial snapshot so a freshly-connected client is in sync.
    try {
      const { seats, released } = await listSeats();
      res.write(`event: snapshot\ndata: ${JSON.stringify({ seats })}\n\n`);
      if (released.length) broadcastSeatChanges(released, 'released');
    } catch {
      /* ignore snapshot failure */
    }

    addClient(res);

    // Heartbeat to keep proxies from closing idle connections.
    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch {
        /* ignore */
      }
    }, 20000);

    req.on('close', () => {
      clearInterval(heartbeat);
      removeClient(res);
    });
  });

  // Beacon-friendly release (navigator.sendBeacon can only POST).
  app.post('/api/holds/:holdId/release', async (req, res, next) => {
    try {
      const sessionId = req.body?.sessionId || req.query.sessionId;
      const result = await releaseHold(req.params.holdId, sessionId);
      broadcastSeatChanges(result.released, 'released');
      broadcastSeatChanges(result.seats, 'released');
      res.json({ released: result.seats, alreadyGone: !!result.alreadyGone });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, clients: clientCount() });
  });

  // ---- Error handler ------------------------------------------------------
  app.use((err, req, res, _next) => {
    if (err instanceof SeatError) {
      // Special case: expiry during confirm releases seats; broadcast them.
      if (err.code === 'hold_expired' && err.extra?.released) {
        broadcastSeatChanges(err.extra.released, 'released');
      }
      return res.status(err.status).json({
        error: err.code,
        message: err.message,
        ...err.extra,
      });
    }
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: 'Internal server error' });
  });

  return app;
}

// Background sweep that releases expired holds and broadcasts the changes.
export function startSweeper() {
  const timer = setInterval(async () => {
    try {
      const released = await sweepExpired();
      if (released.length > 0) {
        broadcastSeatChanges(released, 'released');
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('sweep error', err);
    }
  }, config.sweepIntervalMs);
  timer.unref?.();
  return timer;
}

// Start the server unless imported (e.g. by tests).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  createServer()
    .then((app) => {
      app.listen(config.port, () => {
        // eslint-disable-next-line no-console
        console.log(`Seat-booking server listening on http://localhost:${config.port}`);
        // eslint-disable-next-line no-console
        console.log(
          `Seat map: ${config.rows} rows x ${config.seatsPerRow} seats, hold TTL ${config.holdTtlMs}ms`
        );
      });
      startSweeper();
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Failed to start server', err);
      process.exit(1);
    });
}
