import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './db.js';
import {
  parseLogParams,
  queryLogs,
  queryStats,
  ValidationError,
} from './queries.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

async function main() {
  const bootStart = Date.now();
  const db = await getDb(); // seeds on first boot, skips otherwise
  console.log(`[boot] db ready in ${Date.now() - bootStart}ms`);

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
      console.error('[/api/stats]', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.get('/api/logs', async (req, res) => {
    let params;
    try {
      params = parseLogParams(req.query);
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
    try {
      const result = await queryLogs(db, params);
      res.json(result);
    } catch (err) {
      console.error('[/api/logs]', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Serve the built client in production if present.
  const distDir = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(distDir));

  app.listen(PORT, () => {
    console.log(`[boot] serving on http://localhost:${PORT} (total ${Date.now() - bootStart}ms)`);
  });
}

main().catch((err) => {
  console.error('fatal', err);
  process.exit(1);
});
