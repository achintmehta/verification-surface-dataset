/**
 * Entry point – creates the Express app, initialises PGLite, and starts
 * the HTTP server together with the periodic expiry sweep.
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';
import routes from './routes.js';
import { sweepExpiredHolds } from './seats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT ?? 3001;

const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors({
  origin: true,          // reflect the request origin (dev-friendly)
  credentials: true,
}));
app.use(express.json());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use('/api', routes);

// Health check
app.get('/health', (_req, res) => res.json({ ok: true }));

// Serve built frontend in production.
const publicDir = path.resolve(__dirname, '../public');
app.use(express.static(publicDir));
// SPA fallback – serve index.html for any non-API route.
app.get('*', (_req, res) => {
  const indexPath = path.join(publicDir, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) res.status(404).send('Not found');
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main() {
  try {
    // Ensure the DB is ready before accepting requests.
    await getDb();
    console.log('[server] Database ready.');

    app.listen(PORT, () => {
      console.log(`[server] Listening on http://localhost:${PORT}`);
    });

    // Periodic sweep every 10 seconds to release expired holds and broadcast.
    setInterval(sweepExpiredHolds, 10_000);
    console.log('[server] Expiry sweep scheduled every 10 s.');
  } catch (err) {
    console.error('[server] Fatal startup error:', err);
    process.exit(1);
  }
}

main();
