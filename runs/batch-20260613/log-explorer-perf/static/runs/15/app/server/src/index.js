import express from 'express';
import cors from 'cors';
import { seedIfNeeded } from './seed.js';
import { parseParams, queryLogs, queryStats, ParamError, MAX_LIMIT } from './queries.js';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;

const app = express();
app.use(cors());
app.use(express.json());

let ready = false;

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ready });
});

app.get('/api/stats', async (_req, res) => {
  if (!ready) return res.status(503).json({ error: 'seeding in progress' });
  try {
    const stats = await queryStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/logs', async (req, res) => {
  if (!ready) return res.status(503).json({ error: 'seeding in progress' });
  let params;
  try {
    params = parseParams(req.query);
  } catch (err) {
    if (err instanceof ParamError) {
      return res.status(400).json({ error: err.message });
    }
    return res.status(500).json({ error: String(err.message || err) });
  }
  try {
    const result = await queryLogs(params);
    // Hard guarantee: never emit more than MAX_LIMIT rows.
    if (result.rows.length > MAX_LIMIT) {
      result.rows = result.rows.slice(0, MAX_LIMIT);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

async function boot() {
  const t0 = Date.now();
  console.log('[boot] initializing database + seed...');
  const result = await seedIfNeeded();
  ready = true;
  console.log(
    `[boot] ${result.seeded ? 'seeded' : 'reused'} ${result.rows} rows in ${result.ms}ms ` +
      `(total boot ${Date.now() - t0}ms)`
  );
}

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  boot().catch((err) => {
    console.error('[boot] failed:', err);
    process.exit(1);
  });
});
