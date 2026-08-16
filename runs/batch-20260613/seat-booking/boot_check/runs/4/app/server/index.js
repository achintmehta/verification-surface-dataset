import express from 'express';
import cors from 'cors';
import { initDb, getDb } from './db.js';
import { broadcast } from './sse.js';
import { startExpiryLoop } from './expiry.js';
import seatsRouter from './routes/seats.js';
import holdsRouter from './routes/holds.js';
import streamRouter from './routes/stream.js';

const PORT = process.env.PORT || 3001;

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/seats', seatsRouter);
app.use('/api/holds', holdsRouter);
app.use('/api/stream', streamRouter);

// Health check
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// ── PGLite serialisation mutex ────────────────────────────────────────────────
// PGLite is single-connection; we serialise all writes through a simple
// promise-chain mutex so concurrent requests don't interleave transactions.
// NOTE: The route handlers call db.transaction() directly; the mutex is only
// used by the background expiry sweep to avoid overlapping with in-flight
// requests. Express itself is single-threaded (event loop), so overlapping
// async operations on PGLite are safe as long as we await each transaction
// fully before starting the next one. The expiry loop uses the same mutex.

let _lock = Promise.resolve();

function acquireLock(fn) {
  const next = _lock.then(() => fn());
  _lock = next.catch(() => {});
  return next;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function main() {
  try {
    await initDb();

    const db = await getDb();

    // Start background expiry sweep every 5 seconds
    startExpiryLoop(db, broadcast, 5_000, acquireLock);

    app.listen(PORT, () => {
      console.log(`[server] Listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('[server] Failed to start:', err);
    process.exit(1);
  }
}

main();
