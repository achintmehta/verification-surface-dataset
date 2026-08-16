import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3001);
const DB_DIR = path.resolve(__dirname, '..', '.pglite');
const TOTAL_ROWS = 100_000;
const MAX_LIMIT = 200;
const SERVICES = ['auth', 'billing', 'catalog', 'checkout', 'edge', 'payments', 'search', 'worker'];
const SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const BASE_TIME = Date.parse('2025-01-30T23:59:59.000Z');
const SPAN_MS = 30 * 24 * 60 * 60 * 1000;
const pg = new PGlite(DB_DIR);

function mulberry32(seed) {
  return function rand() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function severityFor(i) {
  const mod = i % 100;
  if (mod < 60) return 'debug';
  if (mod < 85) return 'info';
  if (mod < 95) return 'warn';
  return 'error';
}

const actions = ['accepted', 'processed', 'retried', 'queued', 'completed', 'rejected', 'validated', 'persisted'];
const resources = ['session', 'invoice', 'cart', 'token', 'webhook', 'profile', 'shipment', 'query'];
const regions = ['us-east', 'us-west', 'eu-central', 'ap-south'];
const templates = [
  ({ service, action, resource, region, user, req, latency }) => `${service} ${action} ${resource} for user-${user} in ${region} request=${req} latency=${latency}ms`,
  ({ service, resource, region, user, req, latency }) => `${service} observed cache hit for ${resource} user-${user} ${region} request=${req} latency=${latency}ms`,
  ({ service, action, resource, req, latency, shard }) => `${service} ${action} ${resource} on shard-${shard} request=${req} duration=${latency}ms`,
  ({ service, resource, region, user, req }) => `${service} fallback path for ${resource} user-${user} in ${region} request=${req}`,
  ({ service, action, resource, region, req, code }) => `${service} ${action} ${resource} with status=${code} in ${region} request=${req}`,
];

function makeMessage(i, severity, service, rand) {
  const ctx = {
    service,
    action: actions[i % actions.length],
    resource: resources[(i * 7) % resources.length],
    region: regions[(i * 13) % regions.length],
    user: Math.floor(rand() * 5000),
    req: `req-${String(i).padStart(6, '0')}`,
    latency: 5 + Math.floor(rand() * 2000),
    shard: (i * 17) % 32,
    code: severity === 'error' ? 500 + (i % 25) : severity === 'warn' ? 400 + (i % 50) : 200 + (i % 9),
  };
  let msg = templates[i % templates.length](ctx);
  if (i % 2 === 0) msg += ' common heartbeat'; // deliberately non-selective term
  if (i % 997 === 0) msg += ' rare-needle'; // selective term
  if (severity === 'error') msg += ' exception stacktrace alert';
  if (severity === 'warn') msg += ' threshold slow warning';
  return msg;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function initDb() {
  await fs.mkdir(DB_DIR, { recursive: true });
  await pg.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL,
      message_lc TEXT NOT NULL
    );
  `);

  const countRes = await pg.query('SELECT COUNT(*)::int AS count FROM logs;');
  const existing = Number(countRes.rows[0]?.count || 0);
  if (existing !== TOTAL_ROWS) {
    if (existing !== 0) await pg.query('TRUNCATE logs;');
    console.log(`Seeding ${TOTAL_ROWS} deterministic log rows...`);
    const started = Date.now();
    await pg.query('BEGIN;');
    try {
      const batchSize = 2500;
      const rand = mulberry32(0xc0ffee);
      const step = Math.floor(SPAN_MS / TOTAL_ROWS);
      for (let start = 1; start <= TOTAL_ROWS; start += batchSize) {
        const values = [];
        const end = Math.min(TOTAL_ROWS, start + batchSize - 1);
        for (let id = start; id <= end; id++) {
          // id 1 is newest; order by ts desc is stable via id desc tie-breaker.
          const ts = new Date(BASE_TIME - (id - 1) * step).toISOString();
          const severity = severityFor(id - 1);
          const service = SERVICES[(id * 37) % SERVICES.length];
          const message = makeMessage(id, severity, service, rand);
          values.push(`(${id}, ${sqlString(ts)}, ${sqlString(severity)}, ${sqlString(service)}, ${sqlString(message)}, ${sqlString(message.toLowerCase())})`);
        }
        await pg.query(`INSERT INTO logs (id, ts, severity, service, message, message_lc) VALUES ${values.join(',')};`);
      }
      await pg.query('COMMIT;');
      console.log(`Seed complete in ${Date.now() - started}ms`);
    } catch (error) {
      await pg.query('ROLLBACK;');
      throw error;
    }
  } else {
    console.log(`PGLite corpus already contains ${existing} rows; skipping seed.`);
  }

  // Build/verify indexes after seeding. The DESC id tie-breaker keeps deep pages deterministic.
  await pg.query('CREATE INDEX IF NOT EXISTS idx_logs_ts_id_desc ON logs (ts DESC, id DESC);');
  await pg.query('CREATE INDEX IF NOT EXISTS idx_logs_sev_ts_id_desc ON logs (severity, ts DESC, id DESC);');
  await pg.query('CREATE INDEX IF NOT EXISTS idx_logs_message_lc ON logs (message_lc);');
  await pg.query('ANALYZE logs;');
}

function parseLogsQuery(req, res) {
  const offsetRaw = req.query.offset ?? '0';
  const limitRaw = req.query.limit ?? '100';
  if (!/^\d+$/.test(String(offsetRaw))) return res.status(400).json({ error: 'offset must be a non-negative integer' });
  if (!/^\d+$/.test(String(limitRaw))) return res.status(400).json({ error: 'limit must be an integer between 1 and 200' });
  const offset = Number(offsetRaw);
  const limit = Number(limitRaw);
  if (!Number.isSafeInteger(offset) || offset < 0) return res.status(400).json({ error: 'offset must be a non-negative integer' });
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) return res.status(400).json({ error: 'limit must be between 1 and 200' });
  const severity = req.query.severity ? String(req.query.severity).toLowerCase() : '';
  if (severity && !SEVERITIES.has(severity)) return res.status(400).json({ error: 'unknown severity' });
  const q = req.query.q == null ? '' : String(req.query.q).trim().toLowerCase();
  return { offset, limit, severity, q };
}

function buildWhere({ severity, q }, params) {
  const clauses = [];
  if (severity) {
    params.push(severity);
    clauses.push(`severity = $${params.length}`);
  }
  if (q) {
    params.push(`%${q.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`);
    clauses.push(`message_lc LIKE $${params.length} ESCAPE '\\'`);
  }
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/logs', async (req, res, next) => {
  try {
    const parsed = parseLogsQuery(req, res);
    if (!parsed || parsed.offset == null) return;
    const params = [];
    const where = buildWhere(parsed, params);
    const countSql = `SELECT COUNT(*)::int AS total FROM logs ${where};`;
    const countParams = [...params];
    params.push(parsed.limit, parsed.offset);
    const rowsSql = `
      SELECT id, ts, severity, service, message
      FROM logs
      ${where}
      ORDER BY ts DESC, id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length};
    `;
    const [countRes, rowsRes] = await Promise.all([
      pg.query(countSql, countParams),
      pg.query(rowsSql, params),
    ]);
    res.json({ total: Number(countRes.rows[0]?.total || 0), rows: rowsRes.rows });
  } catch (error) {
    next(error);
  }
});

app.get('/api/stats', async (_req, res, next) => {
  try {
    const result = await pg.query(`
      SELECT severity, COUNT(*)::int AS count
      FROM logs
      GROUP BY severity;
    `);
    const counts = { debug: 0, info: 0, warn: 0, error: 0 };
    let total = 0;
    for (const row of result.rows) {
      counts[row.severity] = Number(row.count);
      total += Number(row.count);
    }
    res.json({ total, severities: counts });
  } catch (error) {
    next(error);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Log explorer API listening on http://localhost:${PORT}`));
  })
  .catch((error) => {
    console.error('Failed to initialize database', error);
    process.exit(1);
  });
