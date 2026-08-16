import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { parseLogParams, queryLogs, queryStats } from './queries.js';

const PORT = process.env.PORT || 3001;

async function main() {
  await initDb();

  const app = express();
  app.use(cors());
  app.use(express.json());

  // Windowed, filtered log query. Returns { total, rows }.
  app.get('/api/logs', async (req, res) => {
    const parsed = parseLogParams(req.query);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }
    try {
      const result = await queryLogs(parsed.params);
      res.json(result);
    } catch (err) {
      console.error('[api] /api/logs error', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Corpus stats for the filter bar badges.
  app.get('/api/stats', async (_req, res) => {
    try {
      const stats = await queryStats();
      res.json(stats);
    } catch (err) {
      console.error('[api] /api/stats error', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.listen(PORT, () => {
    console.log('[server] listening on http://localhost:%d', PORT);
  });
}

main().catch((err) => {
  console.error('[server] fatal startup error', err);
  process.exit(1);
});
