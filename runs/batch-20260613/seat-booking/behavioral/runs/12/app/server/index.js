import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { initDb } from './db.js';
import { BookingService, BookingError } from './booking.js';
import { SSEHub } from './sse.js';
import { PORT, DATA_DIR, SWEEP_INTERVAL_MS, HOLD_TTL_MS } from './config.js';

/**
 * Build the Express app + dependencies. Exported for tests (with an in-memory db).
 *
 * @param {object} [opts]
 * @param {import('@electric-sql/pglite').PGlite} [opts.db]
 * @param {number} [opts.ttlMs]
 * @param {boolean} [opts.startSweep]
 * @returns {Promise<{ app: import('express').Express, db, service: BookingService, hub: SSEHub, stopSweep: () => void }>}
 */
export async function createServer(opts = {}) {
  const db = opts.db || (await initDb(opts.dataDir ?? DATA_DIR));
  const service = new BookingService(db, { ttlMs: opts.ttlMs ?? HOLD_TTL_MS });
  const hub = new SSEHub();

  const app = express();
  app.use(cors());
  app.use(express.json());

  // --- Seat map -------------------------------------------------------------
  app.get('/api/seats', async (req, res, next) => {
    try {
      const { seats, released, summary } = await service.getSeats();
      hub.broadcastSeats(released, 'released');
      res.json({ seats, summary, holdTtlMs: service.ttlMs });
    } catch (err) {
      next(err);
    }
  });

  // --- Create a hold (atomic, all-or-nothing) -------------------------------
  app.post('/api/holds', async (req, res, next) => {
    try {
      const { seatIds, sessionId } = req.body || {};
      const result = await service.createHold(seatIds, sessionId);
      hub.broadcastSeats(result._released, 'released');
      hub.broadcastSeats(result.changed, 'held');
      res.status(201).json({
        hold: serialiseHold(result.hold),
        seats: result.seats,
      });
    } catch (err) {
      next(err);
    }
  });

  // --- Confirm a hold (transactional + idempotent) --------------------------
  app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
    try {
      const { sessionId } = req.body || {};
      const result = await service.confirmHold(req.params.holdId, sessionId);
      hub.broadcastSeats(result._released, 'released');
      hub.broadcastSeats(result.changed, 'booked');
      res.json({
        hold: serialiseHold(result.hold),
        seats: result.seats,
        alreadyConfirmed: result.alreadyConfirmed,
      });
    } catch (err) {
      next(err);
    }
  });

  // --- Release a hold early -------------------------------------------------
  app.delete('/api/holds/:holdId', async (req, res, next) => {
    try {
      const sessionId = req.body?.sessionId || req.query.sessionId;
      const result = await service.releaseHold(req.params.holdId, sessionId);
      hub.broadcastSeats(result._released, 'released');
      hub.broadcastSeats(result.changed, 'released');
      res.json({ hold: serialiseHold(result.hold), seats: result.seats });
    } catch (err) {
      next(err);
    }
  });

  // --- SSE stream -----------------------------------------------------------
  app.get('/api/stream', (req, res) => {
    const cleanup = hub.addClient(res);
    req.on('close', cleanup);
  });

  app.get('/api/health', (req, res) => res.json({ ok: true, clients: hub.size }));

  // --- Error handler --------------------------------------------------------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof BookingError) {
      return res.status(err.status).json({ error: err.message, ...(err.detail || {}) });
    }
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  // --- Background sweep -----------------------------------------------------
  let timer = null;
  if (opts.startSweep !== false) {
    timer = setInterval(async () => {
      try {
        const released = await service.sweepExpired();
        hub.broadcastSeats(released, 'released');
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('sweep error', err);
      }
    }, SWEEP_INTERVAL_MS);
    if (timer.unref) timer.unref();
  }

  const stopSweep = () => {
    if (timer) clearInterval(timer);
  };

  return { app, db, service, hub, stopSweep };
}

function serialiseHold(hold) {
  if (!hold) return null;
  return {
    id: hold.id,
    sessionId: hold.session_id,
    status: hold.status,
    createdAt: hold.created_at,
    expiresAt: hold.expires_at,
    confirmedAt: hold.confirmed_at,
  };
}

// Start the server when run directly (not when imported by tests).
const isMain = (() => {
  try {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '');
  } catch {
    return false;
  }
})();

if (isMain) {
  createServer()
    .then(({ app }) => {
      app.listen(PORT, () => {
        // eslint-disable-next-line no-console
        console.log(`Seat-booking server listening on http://localhost:${PORT}`);
      });
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Failed to start server', err);
      process.exit(1);
    });
}
