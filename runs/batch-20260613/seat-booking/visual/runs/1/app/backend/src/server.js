/**
 * server.js – Express entry point.
 *
 * Starts the HTTP server, initialises PGLite, mounts routes, and kicks off
 * the background hold-expiry sweep.
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, withDb } from './db.js';
import { releaseExpiredHolds, broadcastReleases } from './expiry.js';
import seatsRouter from './routes/seats.js';
import holdsRouter from './routes/holds.js';
import streamRouter from './routes/stream.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT ?? 3001;

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/seats', seatsRouter);
app.use('/api/holds', holdsRouter);
app.use('/api/stream', streamRouter);

// Health check
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Serve built frontend (production)
// __dirname = .../app/backend/src  →  go up 2 levels to app/, then into frontend/dist
const frontendDist = path.resolve(__dirname, '..', '..', 'frontend', 'dist');
app.use(express.static(frontendDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'));
});

// ── Background expiry sweep ───────────────────────────────────────────────────
// Runs every 5 seconds to release stale holds even when no requests arrive.
function startExpirySweep() {
  setInterval(async () => {
    try {
      await withDb(async (db) => {
        const released = await releaseExpiredHolds(db);
        broadcastReleases(released);
      });
    } catch (err) {
      console.error('[sweep] Error during expiry sweep:', err);
    }
  }, 5_000);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function main() {
  try {
    await initDb();
    console.log('[server] Database initialised.');

    startExpirySweep();
    console.log('[server] Expiry sweep started (every 5 s).');

    app.listen(PORT, () => {
      console.log(`[server] Listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('[server] Fatal startup error:', err);
    process.exit(1);
  }
}

main();
