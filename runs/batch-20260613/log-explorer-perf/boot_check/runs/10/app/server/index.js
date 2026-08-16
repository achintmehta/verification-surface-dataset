import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data', 'pglite');
const PORT = Number(process.env.PORT || 3000);
const ROW_COUNT = 100_000;
const BATCH_SIZE = 5000;
const SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const SERVICES = ['auth', 'billing', 'checkout', 'inventory', 'search', 'notifications', 'gateway', 'worker'];
const BASE_TIME = Date.UTC(2026, 0, 1, 0, 0, 0);
const SPAN_MS = 30 * 24 * 60 * 60 * 1000;

await fs.mkdir(dataDir, { recursive: true });
const db = new PGlite(dataDir);
let severityCountsCache = { debug: 0, info: 0, warn: 0, error: 0 };
let totalCountCache = 0;

function severityFor(i) {
  const r = (i * 97) % 100;
  if (r < 60) return 'info';
  if (r < 85) return 'debug';
  if (r < 95) return 'warn';
  return 'error';
}

function esc(v) {
  return String(v).replaceAll("'", "''");
}

function messageFor(i, severity, service) {
  const user = 1000 + ((i * 7919) % 900000);
  const req = ((i * 2654435761) >>> 0).toString(16).padStart(8, '0');
  const latency = 5 + ((i * 37) % 1995);
  const shard = (i * 13) % 64;
  const region = ['us-east', 'us-west', 'eu-central', 'ap-south'][i % 4];
  const route = ['/login', '/cart', '/search', '/pay', '/api/items', '/health'][i % 6];

  // Common tokens make intentionally non-selective substring filters; rarer tokens
  // make selective filters without requiring custom search extensions.
  if (severity === 'error') {
    const rare = i % 97 === 0 ? ' rare-critical-sentinel' : '';
    return `${service} request ${req} failed for user ${user} on ${route} in ${region}; timeout after ${latency}ms shard=${shard}${rare}`;
  }
  if (severity === 'warn') {
    const rare = i % 89 === 0 ? ' rare-cache-sentinel' : '';
    return `${service} request ${req} slow response ${latency}ms for user ${user}; retry scheduled shard=${shard} region=${region}${rare}`;
  }
  if (severity === 'debug') {
    const rare = i % 83 === 0 ? ' rare-debug-sentinel' : '';
    return `${service} request ${req} trace checkpoint route=${route} user=${user} cache lookup shard=${shard} region=${region}${rare}`;
  }
  const rare = i % 101 === 0 ? ' rare-info-sentinel' : '';
  return `${service} request ${req} completed route=${route} status=ok user=${user} latency=${latency}ms shard=${shard} region=${region}${rare}`;
}

async function initDb() {
  console.time('database initialized');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id integer PRIMARY KEY,
      ts timestamptz NOT NULL,
      severity text NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service text NOT NULL,
      message text NOT NULL,
      message_lc text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS log_stats (
      key text PRIMARY KEY,
      value integer NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_logs_ts_id_desc ON logs (ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_sev_ts_id_desc ON logs (severity, ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_msg_lc ON logs (message_lc);
  `);
  const countResult = await db.query('SELECT COUNT(*)::int AS count FROM logs');
  const existing = Number(countResult.rows[0]?.count || 0);
  if (existing === ROW_COUNT) {
    await loadStatsCache();
    console.log(`seed skipped: ${existing} log rows already present`);
    console.timeEnd('database initialized');
    return;
  }
  console.log(`seeding deterministic corpus (${ROW_COUNT} rows); existing rows=${existing}`);
  await db.exec('DROP TABLE IF EXISTS logs; DROP TABLE IF EXISTS log_stats;');
  await db.exec(`
    CREATE TABLE logs (
      id integer PRIMARY KEY,
      ts timestamptz NOT NULL,
      severity text NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service text NOT NULL,
      message text NOT NULL,
      message_lc text NOT NULL
    );
    CREATE TABLE log_stats (
      key text PRIMARY KEY,
      value integer NOT NULL
    );
  `);
  for (let start = 1; start <= ROW_COUNT; start += BATCH_SIZE) {
    const end = Math.min(ROW_COUNT, start + BATCH_SIZE - 1);
    const values = [];
    for (let id = start; id <= end; id++) {
      const idx = id - 1;
      const severity = severityFor(idx);
      const service = SERVICES[(idx * 17) % SERVICES.length];
      // Monotonic timestamps spanning exactly 30 deterministic days.
      const ts = new Date(BASE_TIME + Math.floor((idx / (ROW_COUNT - 1)) * SPAN_MS)).toISOString();
      const message = messageFor(idx, severity, service);
      values.push(`(${id}, '${ts}', '${severity}', '${service}', '${esc(message)}', '${esc(message.toLowerCase())}')`);
    }
    await db.exec(`INSERT INTO logs (id, ts, severity, service, message, message_lc) VALUES ${values.join(',')}`);
    if (end % 25000 === 0) console.log(`seeded ${end}/${ROW_COUNT}`);
  }
  await db.exec(`
    CREATE INDEX idx_logs_ts_id_desc ON logs (ts DESC, id DESC);
    CREATE INDEX idx_logs_sev_ts_id_desc ON logs (severity, ts DESC, id DESC);
    CREATE INDEX idx_logs_msg_lc ON logs (message_lc);
    INSERT INTO log_stats (key, value)
      SELECT severity, COUNT(*)::int FROM logs GROUP BY severity
      UNION ALL SELECT 'total', COUNT(*)::int FROM logs;
    ANALYZE logs;
  `);
  await loadStatsCache();
  console.timeEnd('database initialized');
}

async function loadStatsCache() {
  const statsResult = await db.query('SELECT key, value FROM log_stats');
  const counts = { debug: 0, info: 0, warn: 0, error: 0 };
  let total = 0;
  for (const row of statsResult.rows) {
    if (row.key === 'total') total = Number(row.value);
    else if (row.key in counts) counts[row.key] = Number(row.value);
  }
  if (!total) {
    const fallback = await db.query(`
      SELECT severity AS key, COUNT(*)::int AS value FROM logs GROUP BY severity
      UNION ALL SELECT 'total' AS key, COUNT(*)::int AS value FROM logs
    `);
    for (const row of fallback.rows) {
      if (row.key === 'total') total = Number(row.value);
      else if (row.key in counts) counts[row.key] = Number(row.value);
    }
    await db.exec('DELETE FROM log_stats');
    const values = [`('total', ${total})`, ...Object.entries(counts).map(([k, v]) => `('${k}', ${v})`)];
    await db.exec(`INSERT INTO log_stats (key, value) VALUES ${values.join(',')}`);
  }
  severityCountsCache = counts;
  totalCountCache = total;
}

function parseLogParams(query) {
  const offsetRaw = query.offset ?? '0';
  const limitRaw = query.limit ?? '100';
  if (!/^\d+$/.test(String(offsetRaw))) throw Object.assign(new Error('offset must be a non-negative integer'), { status: 400 });
  if (!/^\d+$/.test(String(limitRaw))) throw Object.assign(new Error('limit must be an integer from 1 to 200'), { status: 400 });
  const offset = Number(offsetRaw);
  const limit = Number(limitRaw);
  if (!Number.isSafeInteger(offset) || offset < 0) throw Object.assign(new Error('offset must be a non-negative integer'), { status: 400 });
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw Object.assign(new Error('limit must be between 1 and 200'), { status: 400 });
  const severity = query.severity ? String(query.severity).toLowerCase() : '';
  if (severity && !SEVERITIES.has(severity)) throw Object.assign(new Error('unknown severity'), { status: 400 });
  const q = query.q == null ? '' : String(query.q).trim().toLowerCase();
  return { offset, limit, severity, q };
}

function buildWhere({ severity, q }) {
  const clauses = [];
  const params = [];
  if (severity) {
    params.push(severity);
    clauses.push(`severity = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    clauses.push(`message_lc LIKE $${params.length}`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/logs', async (req, res, next) => {
  try {
    const parsed = parseLogParams(req.query);
    const { where, params } = buildWhere(parsed);
    let totalPromise;
    if (!parsed.q && !parsed.severity) totalPromise = Promise.resolve(totalCountCache);
    else if (!parsed.q && parsed.severity) totalPromise = Promise.resolve(severityCountsCache[parsed.severity] || 0);
    else totalPromise = db.query(`SELECT COUNT(*)::int AS total FROM logs ${where}`, params).then((r) => Number(r.rows[0]?.total || 0));
    const rowsSql = `SELECT id, ts, severity, service, message FROM logs ${where} ORDER BY ts DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    const [total, rowsResult] = await Promise.all([
      totalPromise,
      db.query(rowsSql, [...params, parsed.limit, parsed.offset])
    ]);
    res.json({ total, rows: rowsResult.rows });
  } catch (err) {
    next(err);
  }
});

app.get('/api/stats', async (_req, res) => {
  res.json({ total: totalCountCache, severities: severityCountsCache });
});

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Internal server error' });
});

await initDb();
const server = app.listen(PORT, () => {
  console.log(`log explorer API listening on http://localhost:${PORT}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
