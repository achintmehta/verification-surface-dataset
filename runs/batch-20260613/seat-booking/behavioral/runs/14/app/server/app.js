import express from 'express';
import cors from 'cors';
import { SeatStore } from './store.js';
import { SseHub } from './sse.js';

/**
 * Build the Express application around an initialized PGlite db.
 * Exported separately from the server bootstrap so tests can mount it.
 *
 * @param {import('@electric-sql/pglite').PGlite} db
 * @param {object} [opts]
 * @param {number} [opts.holdTtlMs]
 * @param {number} [opts.sweepIntervalMs]
 * @returns {{app: import('express').Express, store: SeatStore, hub: SseHub, stopSweep: ()=>void}}
 */
export function createApp(db, opts = {}) {
  const hub = new SseHub();
  const store = new SeatStore(db, {
    holdTtlMs: opts.holdTtlMs,
    onBroadcast: (events) => hub.broadcast(events),
  });

  const app = express();
  app.use(cors());
  app.use(express.json());

  // --- Seat map ---
  app.get('/api/seats', async (_req, res) => {
    try {
      const seats = await store.getSeats();
      res.json({ seats, ttlMs: store.holdTtlMs });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  app.get('/api/summary', async (_req, res) => {
    try {
      res.json(await store.summary());
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // --- Create hold ---
  app.post('/api/holds', async (req, res) => {
    try {
      const { seatIds, sessionId } = req.body || {};
      const result = await store.createHold(seatIds, sessionId);
      if (result.ok) {
        res.status(201).json(result.hold);
      } else {
        res.status(result.status).json({ error: result.error, conflicts: result.conflicts });
      }
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // --- Confirm hold (idempotent) ---
  app.post('/api/holds/:holdId/confirm', async (req, res) => {
    try {
      const result = await store.confirmHold(req.params.holdId);
      if (result.ok) {
        res.status(200).json(result.booking);
      } else {
        res.status(result.status).json({ error: result.error });
      }
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // --- Release hold early ---
  app.delete('/api/holds/:holdId', async (req, res) => {
    try {
      const result = await store.releaseHold(req.params.holdId);
      if (result.ok) {
        res.status(200).json({ released: result.released });
      } else {
        res.status(result.status).json({ error: result.error });
      }
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // --- SSE stream ---
  app.get('/api/stream', (req, res) => {
    hub.addClient(req, res);
  });

  // --- Periodic sweep ---
  const sweepInterval = opts.sweepIntervalMs ?? 1000;
  let timer = null;
  if (sweepInterval > 0) {
    timer = setInterval(() => {
      store.sweep().catch(() => {});
    }, sweepInterval);
    if (timer.unref) timer.unref();
  }
  const stopSweep = () => {
    if (timer) clearInterval(timer);
    hub.closeAll();
  };

  return { app, store, hub, stopSweep };
}
