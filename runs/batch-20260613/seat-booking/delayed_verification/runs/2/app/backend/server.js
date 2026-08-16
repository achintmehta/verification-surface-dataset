/**
 * server.js – Express entry point.
 *
 * Starts the HTTP server, wires up routes, and launches the background
 * hold-expiry sweep + SSE keepalive.
 */

import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { releaseExpiredHolds } from './expiry.js';
import { broadcastSeatUpdate, startKeepalive } from './sse.js';
import { dbMutex } from './mutex.js';

import seatsRouter  from './routes/seats.js';
import holdsRouter  from './routes/holds.js';
import streamRouter from './routes/stream.js';

const PORT = process.env.PORT ?? 3001;

const app = express();

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Routes ─────────────────────────────────────────────────────────────────
app.use('/api/seats',  seatsRouter);
app.use('/api/holds',  holdsRouter);
app.use('/api/stream', streamRouter);

// Health check.
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ── Bootstrap ──────────────────────────────────────────────────────────────
async function start() {
  // Ensure DB is ready before accepting requests.
  await getDb();
  console.log('[db] PGLite ready.');

  // Background sweep: release expired holds every 10 seconds.
  setInterval(async () => {
    try {
      const db = await getDb();
      const freed = await dbMutex.run(() => releaseExpiredHolds(db));
      if (freed.length > 0) {
        console.log(`[sweep] Released ${freed.length} expired seat(s):`, freed);
        broadcastSeatUpdate(freed.map(id => ({ id, status: 'available', holdId: null, expiresAt: null })));
      }
    } catch (err) {
      console.error('[sweep] Error:', err);
    }
  }, 10_000);

  // SSE keepalive ping every 15 seconds.
  startKeepalive(15_000);

  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
