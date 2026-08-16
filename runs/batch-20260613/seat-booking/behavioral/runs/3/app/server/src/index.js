/**
 * Entry point: creates the Express app, mounts routes, starts the server.
 */

import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';
import { startExpirySweep } from './expiry.js';
import seatsRouter from './routes/seats.js';
import holdsRouter from './routes/holds.js';
import streamRouter from './routes/stream.js';

export async function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Routes.
  app.use('/api/seats', seatsRouter);
  app.use('/api/holds', holdsRouter);
  app.use('/api/stream', streamRouter);

  // Health check.
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  return app;
}

// Only start the server when this file is run directly (not imported by tests).
// Compare the resolved path of this module with the entry point.
const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] === __filename;

if (isMain) {
  const PORT = process.env.PORT || 3001;

  (async () => {
    try {
      const db = await getDb();
      const app = await createApp();

      app.listen(PORT, () => {
        console.log(`[server] Listening on http://localhost:${PORT}`);
      });

      // Start background expiry sweep every 5 seconds.
      startExpirySweep(db, 5000);
    } catch (err) {
      console.error('[server] Failed to start:', err);
      process.exit(1);
    }
  })();
}
