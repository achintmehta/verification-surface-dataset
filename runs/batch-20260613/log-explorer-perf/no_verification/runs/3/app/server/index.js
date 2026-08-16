/**
 * Log Explorer – Express server
 *
 * Boots PGLite (seeds on first run), then serves:
 *   GET /api/logs   – windowed, filterable log query
 *   GET /api/stats  – aggregate counts for filter badges
 */

import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import logsRouter  from './routes/logs.js';
import statsRouter from './routes/stats.js';

const PORT = process.env.PORT ?? 3001;

const app = express();

app.use(cors());
app.use(express.json());

// Mount routes
app.use('/api/logs',  logsRouter);
app.use('/api/stats', statsRouter);

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Boot sequence ──────────────────────────────────────────────────────────
const bootStart = Date.now();
console.log('[server] Initializing database…');

getDb()
  .then(() => {
    const elapsed = ((Date.now() - bootStart) / 1000).toFixed(1);
    app.listen(PORT, () => {
      console.log(`[server] Ready in ${elapsed}s – listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[server] Fatal: failed to initialize database', err);
    process.exit(1);
  });
