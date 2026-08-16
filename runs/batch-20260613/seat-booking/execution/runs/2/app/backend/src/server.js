/**
 * Entry point for the seat-booking backend.
 *
 * Starts an Express server with:
 *   - CORS enabled for the Vite dev server
 *   - JSON body parsing
 *   - /api/seats    – seat map endpoint
 *   - /api/holds    – hold creation, confirmation, and release
 *   - /api/stream   – SSE endpoint for real-time seat updates
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
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    // Allow any origin in development; tighten for production.
    /^http:\/\/localhost:\d+$/,
  ],
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/seats', seatsRouter);
app.use('/api/holds', holdsRouter);
app.use('/api/stream', streamRouter);

// Health check
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function start() {
  try {
    // Initialise the database (creates tables and seeds seats if needed).
    await getDb();
    console.log('[server] Database ready.');

    // Start the background expiry sweep.
    startExpirySweep();

    app.listen(PORT, () => {
      console.log(`[server] Listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('[server] Failed to start:', err);
    process.exit(1);
  }
}

start();
