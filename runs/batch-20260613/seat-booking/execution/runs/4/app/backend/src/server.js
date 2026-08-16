/**
 * server.js – Express application entry point.
 *
 * Wires together:
 *   - CORS + JSON body parsing middleware
 *   - PGLite initialisation (schema + seed)
 *   - Route handlers for seats, holds, and SSE stream
 *   - Background hold-expiry sweep
 */

import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { startExpirySweep } from './expiry.js';
import seatsRouter from './routes/seats.js';
import holdsRouter from './routes/holds.js';
import streamRouter from './routes/stream.js';

const PORT = process.env.PORT ?? 3001;

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(
  cors({
    origin: true,   // reflect the request origin (dev-friendly)
    credentials: true,
  })
);
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────

app.use('/api/seats', seatsRouter);
app.use('/api/holds', holdsRouter);
app.use('/api/stream', streamRouter);

// Health check.
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function main() {
  try {
    console.log('[server] Initialising database…');
    const db = await getDb();
    console.log('[server] Database ready.');

    // Start the background expiry sweep (every 15 seconds).
    startExpirySweep(db, 15_000);

    app.listen(PORT, () => {
      console.log(`[server] Listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('[server] Fatal startup error:', err);
    process.exit(1);
  }
}

main();
