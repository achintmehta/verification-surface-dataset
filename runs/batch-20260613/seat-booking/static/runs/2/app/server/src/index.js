/**
 * Entry point – Express server with PGLite, SSE, and seat-booking routes.
 */

import express from 'express';
import cors from 'cors';
import { initSchema } from './schema.js';
import { startExpirySweep } from './expiry.js';
import { sseHandler } from './sse.js';
import seatsRouter from './routes/seats.js';
import holdsRouter from './routes/holds.js';

const PORT = process.env.PORT ?? 3001;

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
app.get('/api/stream', sseHandler);
app.use('/api/seats', seatsRouter);
app.use('/api/holds', holdsRouter);

// Health check
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function start() {
  try {
    console.log('[server] Initialising database schema…');
    await initSchema();
    console.log('[server] Schema ready.');

    startExpirySweep(10_000);

    app.listen(PORT, () => {
      console.log(`[server] Listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('[server] Fatal startup error:', err);
    process.exit(1);
  }
}

start();
