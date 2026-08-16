/**
 * server.js – Express entry point.
 *
 * Mounts all routes, starts the periodic expiry sweep, and listens.
 */

import express from 'express';
import cors    from 'cors';
import { getDb }            from './db.js';
import { sseHandler }       from './sse.js';
import { sweepExpiredHolds, broadcastReleases } from './expiry.js';
import { seatMutex }        from './mutex.js';
import seatsRouter from './routes/seats.js';
import holdsRouter from './routes/holds.js';

const PORT = parseInt(process.env.PORT ?? '3001', 10);

const app = express();

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Routes ─────────────────────────────────────────────────────────────────
app.get('/api/stream', sseHandler);
app.use('/api/seats',  seatsRouter);
app.use('/api/holds',  holdsRouter);

// Health check
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ── Periodic expiry sweep ──────────────────────────────────────────────────
// Runs every 5 seconds to release stale holds even when no requests arrive.
const SWEEP_INTERVAL_MS = 5_000;

async function runSweep() {
  const release = await seatMutex.acquire();
  try {
    const db = await getDb();
    let released = [];
    await db.transaction(async (tx) => {
      released = await sweepExpiredHolds(tx);
    });
    broadcastReleases(released);
  } catch (err) {
    console.error('Periodic sweep error:', err);
  } finally {
    release();
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────
async function main() {
  // Ensure DB is ready before accepting requests.
  await getDb();
  console.log('PGLite database ready.');

  // Start the periodic sweep.
  setInterval(runSweep, SWEEP_INTERVAL_MS);

  app.listen(PORT, () => {
    console.log(`Seat-booking backend listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
