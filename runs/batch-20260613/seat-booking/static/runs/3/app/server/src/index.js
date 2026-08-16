/**
 * Entry point – wires together Express, PGLite, and SSE.
 */

import express from 'express';
import cors from 'cors';
import { initSchema } from './schema.js';
import { startExpirySweep } from './expiry.js';
import seatsRouter from './routes/seats.js';
import holdsRouter from './routes/holds.js';
import streamRouter from './routes/stream.js';

const PORT = process.env.PORT ?? 3001;

const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(
  cors({
    origin: true, // reflect the request origin (dev-friendly)
    credentials: true,
  }),
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
// Boot sequence
// ---------------------------------------------------------------------------

async function main() {
  try {
    console.log('[boot] initialising database schema …');
    await initSchema();
    console.log('[boot] schema ready');

    startExpirySweep();

    app.listen(PORT, () => {
      console.log(`[boot] server listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('[boot] fatal error:', err);
    process.exit(1);
  }
}

main();
