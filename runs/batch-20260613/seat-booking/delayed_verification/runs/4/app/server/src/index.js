/**
 * Entry point for the seat-booking backend.
 *
 * Starts Express, initialises PGLite, mounts routes, and starts the
 * background expiry worker.
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb } from './db.js';
import { startExpiryWorker } from './expiry.js';
import seatsRouter from './routes/seats.js';
import holdsRouter from './routes/holds.js';
import streamRouter from './routes/stream.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const PUBLIC_DIR = path.resolve(__dirname, '../public');

async function main() {
  // Initialise database first.
  await initDb();

  const app = express();

  // ---------------------------------------------------------------------------
  // Middleware
  // ---------------------------------------------------------------------------
  app.use(
    cors({
      origin: true, // reflect request origin (dev-friendly)
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
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Serve built frontend (production mode).
  // In dev mode, Vite serves the frontend on its own port.
  try {
    const { existsSync } = await import('fs');
    if (existsSync(PUBLIC_DIR)) {
      app.use(express.static(PUBLIC_DIR));
      // SPA fallback: serve index.html for any non-API route.
      app.get('*', (_req, res) => {
        res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
      });
      console.log(`[server] Serving static files from ${PUBLIC_DIR}`);
    }
  } catch {
    // No public dir – dev mode, Vite handles the frontend.
  }

  // ---------------------------------------------------------------------------
  // Start server
  // ---------------------------------------------------------------------------
  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });

  // Start background expiry sweep every 5 seconds.
  startExpiryWorker(5_000);
}

main().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
