import express from 'express';
import cors from 'cors';
import { PORT } from './config.js';
import { getDb } from './db.js';
import {
  parseLogParams,
  queryLogs,
  queryStats,
  BadRequestError,
} from './queries.js';

async function main() {
  const bootStart = Date.now();
  const db = await getDb();
  console.log(`[server] db ready in ${((Date.now() - bootStart) / 1000).toFixed(1)}s`);

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (req, res) => {
    res.json({ ok: true });
  });

  // Windowed, filterable query. Returns { total, rows }; rows <= limit <= 200.
  app.get('/api/logs', async (req, res, next) => {
    try {
      const params = parseLogParams(req.query);
      const result = await queryLogs(db, params);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Corpus stats for the filter-bar badges.
  app.get('/api/stats', async (req, res, next) => {
    try {
      const stats = await queryStats(db);
      res.json(stats);
    } catch (err) {
      next(err);
    }
  });

  // Error handler: 400 for bad params, 500 otherwise.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof BadRequestError || err.status === 400) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error('[server] unhandled error:', err);
    res.status(500).json({ error: 'internal server error' });
  });

  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] fatal boot error:', err);
  process.exit(1);
});
