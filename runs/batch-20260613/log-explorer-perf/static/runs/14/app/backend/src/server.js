// Express server: windowed/filterable log query API backed by embedded PGLite.
import express from 'express';
import cors from 'cors';
import { PORT } from './config.js';
import { getDb } from './db.js';
import { parseLogParams, queryLogs, queryStats } from './queries.js';

async function main() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Initialize the database (and seed on first boot) before serving requests.
  const startedAt = Date.now();
  const db = await getDb();
  // eslint-disable-next-line no-console
  console.log(`[server] db ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  // GET /api/logs?offset=&limit=&severity=&q=
  app.get('/api/logs', async (req, res) => {
    const parsed = parseLogParams(req.query);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }
    try {
      const result = await queryLogs(db, parsed.value);
      res.json(result);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[server] /api/logs error:', err);
      res.status(500).json({ error: 'query failed' });
    }
  });

  // GET /api/stats
  app.get('/api/stats', async (_req, res) => {
    try {
      const stats = await queryStats(db);
      res.json(stats);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[server] /api/stats error:', err);
      res.status(500).json({ error: 'stats failed' });
    }
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[server] fatal startup error:', err);
  process.exit(1);
});
