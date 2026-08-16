// Express server: CORS, JSON parsing, windowed log API, stats endpoint.
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { initDb } from './db.js';
import { countLogs, queryLogs, getStats } from './logsRepository.js';
import { parseLogQuery, ValidationError } from './validation.js';

async function main() {
  await initDb();

  const app = express();
  app.use(cors());
  app.use(express.json());

  // Windowed, filtered query endpoint. Returns { total, rows } where rows is
  // never larger than the (capped) limit.
  app.get('/api/logs', async (req, res, next) => {
    try {
      const { offset, limit, severity, q } = parseLogQuery(req.query);
      // Count and window in parallel: both are index-backed at full volume.
      const [total, rows] = await Promise.all([
        countLogs({ severity, q }),
        queryLogs({ severity, q, offset, limit }),
      ]);
      res.json({ total, rows });
    } catch (err) {
      next(err);
    }
  });

  // Filter-bar stats: exact total + per-severity counts.
  app.get('/api/stats', async (_req, res, next) => {
    try {
      const stats = await getStats();
      res.json(stats);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // Error handler: validation problems -> 400, everything else -> 500.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error('[server] unhandled error:', err);
    res.status(500).json({ error: 'internal server error' });
  });

  app.listen(config.port, () => {
    console.log('[server] listening on http://localhost:%d', config.port);
  });
}

main().catch((err) => {
  console.error('[server] fatal startup error:', err);
  process.exit(1);
});
