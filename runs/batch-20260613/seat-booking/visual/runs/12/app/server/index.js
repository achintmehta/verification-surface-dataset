import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PORT, SWEEP_INTERVAL_MS } from './config.js';
import { initDb } from './db.js';
import { addClient } from './sse.js';
import {
  listSeats,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpired,
  inventory
} from './seats.js';

async function main() {
  await initDb();

  const app = express();
  app.use(cors());
  app.use(express.json());

  // --- Seat map ---------------------------------------------------------
  app.get('/api/seats', async (_req, res, next) => {
    try {
      const seats = await listSeats();
      res.json({ seats });
    } catch (err) {
      next(err);
    }
  });

  // --- Inventory (diagnostics) -----------------------------------------
  app.get('/api/inventory', async (_req, res, next) => {
    try {
      res.json(await inventory());
    } catch (err) {
      next(err);
    }
  });

  // --- Create hold ------------------------------------------------------
  app.post('/api/holds', async (req, res, next) => {
    try {
      const { seatIds, sessionId } = req.body || {};
      const result = await createHold(seatIds, sessionId);
      if (result.ok) {
        res.status(result.status).json({ hold: result.hold });
      } else {
        res.status(result.status).json(stripOk(result));
      }
    } catch (err) {
      next(err);
    }
  });

  // --- Confirm hold -----------------------------------------------------
  app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
    try {
      const result = await confirmHold(req.params.holdId);
      if (result.ok) {
        res.status(result.status).json({
          booking: result.booking,
          alreadyConfirmed: !!result.alreadyConfirmed
        });
      } else {
        res.status(result.status).json(stripOk(result));
      }
    } catch (err) {
      next(err);
    }
  });

  // --- Release hold -----------------------------------------------------
  app.delete('/api/holds/:holdId', async (req, res, next) => {
    try {
      const result = await releaseHold(req.params.holdId);
      if (result.ok) {
        res.status(result.status).json({ releasedSeatIds: result.releasedSeatIds });
      } else {
        res.status(result.status).json(stripOk(result));
      }
    } catch (err) {
      next(err);
    }
  });

  // --- SSE stream -------------------------------------------------------
  app.get('/api/stream', (req, res) => {
    addClient(res);
  });

  // --- Static frontend (production build) -------------------------------
  const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  if (existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(join(distDir, 'index.html'));
    });
  }

  // --- Error handler ----------------------------------------------------
  app.use((err, _req, res, _next) => {
    // eslint-disable-next-line no-console
    console.error('Request error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  // Periodic sweep to release abandoned holds even with no traffic.
  setInterval(() => {
    sweepExpired().catch((e) => console.error('Sweep error:', e));
  }, SWEEP_INTERVAL_MS);

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Seat-booking server listening on http://localhost:${PORT}`);
  });
}

function stripOk(result) {
  const { ok, status, ...rest } = result;
  return rest;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});
