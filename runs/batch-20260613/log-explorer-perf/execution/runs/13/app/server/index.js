// Express server exposing the windowed log query API.
import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { parseQuery, queryLogs, getStats, MAX_LIMIT } from './logsRepo.js';

const PORT = process.env.PORT || 3001;

async function main() {
  const bootStart = Date.now();
  const db = await getDb();
  console.log(`[boot] DB ready in ${((Date.now() - bootStart) / 1000).toFixed(1)}s`);

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/logs', async (req, res) => {
    const parsed = parseQuery(req.query);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }
    try {
      const result = await queryLogs(db, parsed.params);
      // Hard safety: never return more than the cap.
      if (result.rows.length > MAX_LIMIT) {
        result.rows = result.rows.slice(0, MAX_LIMIT);
      }
      res.json(result);
    } catch (err) {
      console.error('[api/logs] error', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.get('/api/stats', async (_req, res) => {
    try {
      res.json(await getStats(db));
    } catch (err) {
      console.error('[api/stats] error', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.listen(PORT, () => {
    console.log(`[boot] Serving on http://localhost:${PORT} (total ${((Date.now() - bootStart) / 1000).toFixed(1)}s)`);
  });
}

main().catch((err) => {
  console.error('Fatal boot error', err);
  process.exit(1);
});
