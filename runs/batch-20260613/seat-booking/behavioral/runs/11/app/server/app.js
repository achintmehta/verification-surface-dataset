import express from 'express';
import cors from 'cors';
import { BookingService } from './booking.js';
import { SSEHub } from './sse.js';

/**
 * Build the Express app around an already-initialized PGLite db.
 * Returns { app, service, hub, stopSweep }.
 *
 * @param {import('@electric-sql/pglite').PGlite} db
 * @param {{ sweepIntervalMs?: number, now?: () => number }} [opts]
 */
export function createApp(db, opts = {}) {
  const hub = new SSEHub();
  const service = new BookingService(
    db,
    (changes) => hub.broadcastChanges(changes),
    opts.now,
  );

  const app = express();
  app.use(cors());
  app.use(express.json());

  // --- Seat map -----------------------------------------------------------
  app.get('/api/seats', async (req, res, next) => {
    try {
      const [seats, inventory] = await Promise.all([
        service.getSeats(),
        service.getInventory(),
      ]);
      res.json({ seats, inventory });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/inventory', async (req, res, next) => {
    try {
      res.json(await service.getInventory());
    } catch (err) {
      next(err);
    }
  });

  // --- Holds --------------------------------------------------------------
  app.post('/api/holds', async (req, res, next) => {
    try {
      const { seatIds, sessionId } = req.body || {};
      const result = await service.hold(seatIds, sessionId);
      if (!result.ok) {
        return res.status(result.status).json({
          error: result.error,
          conflicts: result.conflicts,
        });
      }
      res.status(201).json(result.hold);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
    try {
      const result = await service.confirm(req.params.holdId);
      if (!result.ok) {
        return res.status(result.status).json({ error: result.error });
      }
      res.json({ booking: result.booking, idempotent: !!result.idempotent });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/holds/:holdId', async (req, res, next) => {
    try {
      const sessionId = req.body?.sessionId || req.query?.sessionId;
      const result = await service.release(req.params.holdId, sessionId);
      if (!result.ok) {
        return res.status(result.status).json({ error: result.error });
      }
      res.json({ released: result.released });
    } catch (err) {
      next(err);
    }
  });

  // --- SSE ----------------------------------------------------------------
  app.get('/api/stream', (req, res) => {
    hub.addClient(res);
  });

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, clients: hub.size });
  });

  // Error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    console.error('[api error]', err);
    res.status(500).json({ error: 'internal server error' });
  });

  // Periodic sweep to release abandoned holds even with no traffic.
  let sweepTimer = null;
  const intervalMs = opts.sweepIntervalMs;
  if (intervalMs && intervalMs > 0) {
    sweepTimer = setInterval(() => {
      service.sweep().catch((e) => console.error('[sweep error]', e));
    }, intervalMs);
    if (sweepTimer.unref) sweepTimer.unref();
  }

  const stopSweep = () => {
    if (sweepTimer) clearInterval(sweepTimer);
  };

  return { app, service, hub, stopSweep };
}
