import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'pglite-data');
const PORT = Number(process.env.PORT || 3001);
const ROW_COUNT = 100_000;
const SERVICES = ['auth', 'api', 'billing', 'search', 'worker', 'cache', 'scheduler', 'gateway'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const INSERT_BATCH = 1000;
const MAX_LIMIT = 200;

let db;
let statsCache = null;

function severityFor(i) {
  // Exact 60/25/10/5 distribution in every 100 rows.
  const r = i % 100;
  if (r < 60) return 'debug';
  if (r < 85) return 'info';
  if (r < 95) return 'warn';
  return 'error';
}

function messageFor(i, severity, service) {
  const user = (i * 7919) % 10000;
  const request = (i * 104729).toString(36).padStart(7, '0');
  const shard = i % 128;
  const latency = 5 + ((i * 37) % 2400);
  const code = ['US', 'EU', 'APAC', 'LATAM'][i % 4];
  const templates = [
    `request ${request} completed for user ${user} in ${latency}ms region ${code} cache ${i % 3 === 0 ? 'hit' : 'miss'}`,
    `cache lookup ${i % 5 === 0 ? 'hot' : 'normal'} for key session:${user} on shard ${shard}`,
    `database query for tenant ${i % 400} returned ${i % 250} rows in ${latency}ms`,
    `background job ${request} processed batch ${i % 700} with queue depth ${i % 90}`,
    `payment workflow ${i % 997} advanced state for account ${user}`,
    `timeout guard observed ${latency}ms operation on dependency ${SERVICES[(i + 3) % SERVICES.length]}`,
    `rare needle incident marker-${i} correlated with trace ${request}`,
    `rate limit check ${i % 11 === 0 ? 'throttled' : 'allowed'} client ${user} path /v1/${service}`
  ];
  const base = templates[i % templates.length];
  const prefix = severity === 'error' ? 'failure' : severity === 'warn' ? 'warning' : 'event';
  return `${prefix}: ${service} ${base}`;
}

async function initDb() {
  await mkdir(DATA_DIR, { recursive: true });
  db = new PGlite(DATA_DIR);
  await db.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);

  const countResult = await db.query('SELECT count(*)::int AS count FROM logs');
  const existing = Number(countResult.rows[0]?.count || 0);
  if (existing !== ROW_COUNT) {
    console.log(`[seed] found ${existing} rows; rebuilding deterministic ${ROW_COUNT} row corpus`);
    await db.query('TRUNCATE logs');
    await seedLogs();
  } else {
    console.log(`[seed] ${ROW_COUNT} rows already present; skipping seed`);
  }

  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_ts_desc ON logs (ts DESC, id ASC)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_id ON logs (id ASC)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_severity_id ON logs (severity, id ASC)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_lower_message ON logs (lower(message))');
  await refreshStatsCache();
}

async function seedLogs() {
  const started = Date.now();
  await db.query('BEGIN');
  try {
    const anchor = Date.UTC(2026, 0, 1, 0, 0, 0);
    const spanMs = 30 * 24 * 60 * 60 * 1000;
    const stepMs = Math.floor(spanMs / ROW_COUNT);
    for (let start = 1; start <= ROW_COUNT; start += INSERT_BATCH) {
      const end = Math.min(ROW_COUNT, start + INSERT_BATCH - 1);
      const values = [];
      const params = [];
      let p = 1;
      for (let id = start; id <= end; id++) {
        const severity = severityFor(id - 1);
        const service = SERVICES[(id - 1) % SERVICES.length];
        // id=1 is newest; ascending id is exactly ts DESC order.
        const ts = new Date(anchor - (id - 1) * stepMs).toISOString();
        const message = messageFor(id - 1, severity, service);
        values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
        params.push(id, ts, severity, service, message);
      }
      await db.query(`INSERT INTO logs (id, ts, severity, service, message) VALUES ${values.join(',')}`, params);
      if (start % 10000 === 1) console.log(`[seed] inserted ${end}/${ROW_COUNT}`);
    }
    await db.query('COMMIT');
    console.log(`[seed] complete in ${Date.now() - started}ms`);
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function refreshStatsCache() {
  const totalResult = await db.query('SELECT count(*)::int AS total FROM logs');
  const severityResult = await db.query(`
    SELECT severity, count(*)::int AS count
    FROM logs
    GROUP BY severity
  `);
  const bySeverity = Object.fromEntries(SEVERITIES.map(s => [s, 0]));
  for (const row of severityResult.rows) bySeverity[row.severity] = Number(row.count);
  statsCache = { total: Number(totalResult.rows[0].total), severity: bySeverity };
}

function bad(res, message) {
  return res.status(400).json({ error: message });
}

function parseLogsQuery(req, res) {
  const rawOffset = req.query.offset ?? '0';
  const rawLimit = req.query.limit ?? '100';
  if (!/^\d+$/.test(String(rawOffset))) return bad(res, 'offset must be a non-negative integer');
  if (!/^\d+$/.test(String(rawLimit))) return bad(res, 'limit must be an integer between 1 and 200');
  const offset = Number(rawOffset);
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(offset) || offset < 0) return bad(res, 'offset must be a non-negative integer');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) return bad(res, 'limit must be between 1 and 200');
  const severity = req.query.severity ? String(req.query.severity) : '';
  if (severity && !SEVERITIES.includes(severity)) return bad(res, 'unknown severity');
  const q = req.query.q ? String(req.query.q).trim() : '';
  return { offset, limit, severity, q };
}

function addFilters({ severity, q }, params) {
  const clauses = [];
  if (severity) {
    params.push(severity);
    clauses.push(`severity = $${params.length}`);
  }
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    clauses.push(`lower(message) LIKE $${params.length}`);
  }
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

async function countForFilters(filters) {
  if (!filters.q && !filters.severity) return statsCache.total;
  if (!filters.q && filters.severity) return statsCache.severity[filters.severity] || 0;
  const params = [];
  const where = addFilters(filters, params);
  const result = await db.query(`SELECT count(*)::int AS total FROM logs ${where}`, params);
  return Number(result.rows[0].total);
}

function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.get('/api/stats', async (req, res, next) => {
    try {
      res.json(statsCache);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/logs', async (req, res, next) => {
    try {
      const parsed = parseLogsQuery(req, res);
      if (!parsed || res.headersSent) return;
      const { offset, limit, severity, q } = parsed;
      const filters = { severity, q };
      const total = await countForFilters(filters);

      let rows;
      if (!severity && !q) {
        // Fast path: deterministic id order exactly matches ts DESC.
        const result = await db.query(
          'SELECT id, ts, severity, service, message FROM logs WHERE id > $1 ORDER BY id ASC LIMIT $2',
          [offset, limit]
        );
        rows = result.rows;
      } else {
        const params = [];
        const where = addFilters(filters, params);
        params.push(limit);
        const limitParam = params.length;
        params.push(offset);
        const offsetParam = params.length;
        const result = await db.query(
          `SELECT id, ts, severity, service, message FROM logs ${where} ORDER BY id ASC LIMIT $${limitParam} OFFSET $${offsetParam}`,
          params
        );
        rows = result.rows;
      }
      res.set('Cache-Control', 'no-store');
      res.json({ total, rows });
    } catch (err) {
      next(err);
    }
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

await initDb();
const app = createApp();
app.listen(PORT, () => {
  console.log(`Log explorer API listening on http://localhost:${PORT}`);
});
