import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { initDb } from './db.js';
import { addClient, clientCount } from './sse.js';
import {
  getSeats,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpired,
  getInventory,
  BookingError,
} from './booking.js';

async function main() {
  await initDb();

  const app = express();
  app.use(cors());
  app.use(express.json());

  // --- Seat map -----------------------------------------------------------
  app.get('/api/seats', async (_req, res, next) => {
    try {
      const seats = await getSeats();
      res.json({ seats });
    } catch (err) {
      next(err);
    }
  });

  // --- Inventory (diagnostics) -------------------------------------------
  app.get('/api/inventory', async (_req, res, next) => {
    try {
      res.json(await getInventory());
    } catch (err) {
      next(err);
    }
  });

  // --- Create hold --------------------------------------------------------
  app.post('/api/holds', async (req, res, next) => {
    try {
      const { seatIds, sessionId } = req.body ?? {};
      const hold = await createHold(seatIds, sessionId);
      res.status(201).json({ hold, ttlMs: config.holdTtlMs });
    } catch (err) {
      next(err);
    }
  });

  // --- Confirm hold -------------------------------------------------------
  app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
    try {
      const result = await confirmHold(req.params.holdId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // --- Release hold -------------------------------------------------------
  app.delete('/api/holds/:holdId', async (req, res, next) => {
    try {
      const result = await releaseHold(req.params.holdId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // --- SSE stream ---------------------------------------------------------
  app.get('/api/stream', async (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    // Initial comment + hello with the current snapshot so a freshly connected
    // client can converge immediately.
    res.write(': connected\n\n');
    try {
      const seats = await getSeats();
      res.write(`event: snapshot\ndata: ${JSON.stringify({ seats })}\n\n`);
    } catch {
      // ignore snapshot errors; client can refetch /api/seats
    }

    addClient(res);

    // Keep-alive heartbeat so proxies don't drop idle connections.
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 25_000);

    req.on('close', () => clearInterval(heartbeat));
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, clients: clientCount() });
  });

  // --- Error handler ------------------------------------------------------
  app.use((err, _req, res, _next) => {
    if (err instanceof BookingError) {
      res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
      return;
    }
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: 'Internal server error' });
  });

  // Periodic sweep to release abandoned holds even without reads.
  setInterval(() => {
    sweepExpired().catch((e) => {
      // eslint-disable-next-line no-console
      console.error('sweep failed', e);
    });
  }, config.sweepIntervalMs);

  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Seat-booking server listening on http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error', err);
  process.exit(1);
});
