import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import {
  parseLogParams,
  queryLogs,
  queryStats,
  BadRequest,
} from './queries.js';

const PORT = process.env.PORT || 3001;

async function main() {
  const bootStart = Date.now();
  const db = await getDb();
  // eslint-disable-next-line no-console
  console.log(`[boot] Database ready in ${Date.now() - bootStart}ms`);

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/stats', async (_req, res) => {
    try {
      const stats = await queryStats(db);
      res.json(stats);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.get('/api/logs', async (req, res) => {
    let params;
    try {
      params = parseLogParams(req.query);
    } catch (err) {
      if (err instanceof BadRequest) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
    try {
      const result = await queryLogs(db, params);
      res.json(result);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[boot] Serving on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal:', err);
  process.exit(1);
});
