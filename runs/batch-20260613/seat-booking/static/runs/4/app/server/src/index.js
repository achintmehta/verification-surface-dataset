/**
 * Entry point for the seat-booking backend.
 *
 * Starts Express, initialises PGLite, mounts routes, and kicks off the
 * background expiry sweep and SSE heartbeat.
 */

import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { startExpirySweep } from './expiry.js';
import { startHeartbeat } from './sse.js';
import seatsRouter from './routes/seats.js';
import holdsRouter from './routes/holds.js';
import streamRouter from './routes/stream.js';

const PORT = process.env.PORT ?? 3001;

async function main() {
  // Initialise the database first – everything else depends on it
  await initDb();

  const app = express();

  // ---------------------------------------------------------------------------
  // Middleware
  // ---------------------------------------------------------------------------
  app.use(
    cors({
      origin: true, // reflect the request origin (dev-friendly)
      credentials: true,
    })
  );
  app.use(express.json());

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------
  app.use('/api/seats', seatsRouter);
  app.use('/api/holds', holdsRouter);
  app.use('/api/stream', streamRouter);

  // Health check
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // ---------------------------------------------------------------------------
  // Start server
  // ---------------------------------------------------------------------------
  app.listen(PORT, () => {
    console.log(`Seat-booking server listening on http://localhost:${PORT}`);
  });

  // Background jobs
  startExpirySweep(10_000);   // sweep every 10 s
  startHeartbeat(15_000);     // SSE heartbeat every 15 s
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
