/**
 * server.js — Express entry point
 *
 * Starts on PORT (default 3001).  All API routes are under /api/.
 */

import express  from 'express';
import cors     from 'cors';
import { initDb } from './db.js';

import summaryRouter    from './routes/summary.js';
import timeseriesRouter from './routes/timeseries.js';
import categoriesRouter from './routes/categories.js';
import recentRouter     from './routes/recent.js';
import settingsRouter   from './routes/settings.js';

const PORT = process.env.PORT ?? 3001;

async function main() {
  // Initialise DB before accepting requests
  await initDb();

  const app = express();

  // ── Middleware ──────────────────────────────────────────────────────────────
  app.use(cors({
    origin: true,          // reflect request origin (dev-friendly)
    credentials: true,
  }));
  app.use(express.json());

  // ── Routes ──────────────────────────────────────────────────────────────────
  app.use('/api/summary',    summaryRouter);
  app.use('/api/timeseries', timeseriesRouter);
  app.use('/api/categories', categoriesRouter);
  app.use('/api/recent',     recentRouter);
  app.use('/api/settings',   settingsRouter);

  // Health-check
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // ── Error handler ───────────────────────────────────────────────────────────
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('[error]', err);
    res.status(500).json({ error: err.message ?? 'Internal server error' });
  });

  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('[fatal]', err);
  process.exit(1);
});
