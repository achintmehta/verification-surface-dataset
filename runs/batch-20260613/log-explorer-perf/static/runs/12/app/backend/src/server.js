// Express server for the log explorer.
import express from 'express';
import cors from 'cors';
import { PORT } from './config.js';
import { getDb } from './db.js';
import { parseParams, runLogQuery, runStatsQuery } from './queries.js';

async function main() {
  const bootStart = Date.now();

  // Initialize DB (and seed on first boot) before we start serving so the
  // "begins serving within N seconds" budget includes seeding.
  const pg = await getDb();
  console.log(`[boot] db ready in ${((Date.now() - bootStart) / 1000).toFixed(1)}s`);

  const app = express();
  app.use(cors());
  app.use(express.json());

  // Windowed, filterable log query.
  app.get('/api/logs', async (req, res) => {
    const parsed = parseParams(req.query);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }
    try {
      const result = await runLogQuery(pg, parsed.value);
      res.json(result);
    } catch (err) {
      console.error('[api/logs] error', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Filter-bar stats: total + per-severity counts.
  app.get('/api/stats', async (_req, res) => {
    try {
      const stats = await runStatsQuery(pg);
      res.json(stats);
    } catch (err) {
      console.error('[api/stats] error', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.listen(PORT, () => {
    console.log(`[boot] serving on http://localhost:${PORT} (total boot ${((Date.now() - bootStart) / 1000).toFixed(1)}s)`);
  });
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
