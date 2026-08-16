import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', '.pglite');
const ROW_COUNT = 100_000;
const BATCH_SIZE = 2_000;
const SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);

const db = new PGlite(DATA_DIR);

function severityFor(i) {
  const n = i % 100;
  if (n < 60) return 'debug';
  if (n < 85) return 'info';
  if (n < 95) return 'warn';
  return 'error';
}

const services = ['auth', 'billing', 'checkout', 'catalog', 'search', 'notifications', 'orders', 'gateway'];
const templates = [
  'request completed for tenant {tenant} path {path} status {status} latency {latency}ms trace {trace}',
  'cache {cacheResult} for key {key} partition {partition} latency {latency}ms trace {trace}',
  'database query {queryType} rows {rows} duration {latency}ms connection pool {pool} trace {trace}',
  'queue job {job} {jobState} attempt {attempt} worker {worker} trace {trace}',
  'feature flag {flag} evaluated as {flagState} tenant {tenant} trace {trace}',
  'rate limit {limitState} client {client} route {path} window {window}s trace {trace}',
  'payment provider {provider} operation {operation} result {result} trace {trace}',
  'background sync shard {shard} checkpoint {checkpoint} result {result} trace {trace}'
];
const paths = ['/api/login', '/api/cart', '/api/orders', '/api/search', '/api/products', '/api/payments'];
const queryTypes = ['select_user', 'insert_order', 'update_inventory', 'select_catalog', 'write_audit'];
const rareTokens = ['needle-alpha', 'needle-beta', 'needle-gamma', 'needle-delta'];

function makeMessage(i, severity, service) {
  const template = templates[i % templates.length];
  const latency = 5 + ((i * 37) % 950);
  const status = severity === 'error' ? 500 + (i % 4) : severity === 'warn' ? 400 + (i % 30) : 200 + (i % 7);
  const result = severity === 'error' ? 'failed' : severity === 'warn' ? 'degraded' : 'ok';
  let message = template
    .replace('{tenant}', `tenant-${(i % 250).toString().padStart(3, '0')}`)
    .replace('{path}', paths[i % paths.length])
    .replace('{status}', String(status))
    .replace('{latency}', String(latency))
    .replace('{trace}', `tr-${(i * 2654435761 >>> 0).toString(16).padStart(8, '0')}`)
    .replace('{cacheResult}', i % 3 === 0 ? 'hit' : 'miss')
    .replace('{key}', `${service}:${i % 1000}`)
    .replace('{partition}', String(i % 64))
    .replace('{queryType}', queryTypes[i % queryTypes.length])
    .replace('{rows}', String((i * 13) % 5000))
    .replace('{pool}', `${1 + (i % 16)}/${16}`)
    .replace('{job}', ['email', 'invoice', 'reindex', 'webhook'][i % 4])
    .replace('{jobState}', severity === 'error' ? 'dead-lettered' : i % 7 === 0 ? 'retrying' : 'completed')
    .replace('{attempt}', String(1 + (i % 5)))
    .replace('{worker}', `worker-${i % 48}`)
    .replace('{flag}', ['new-nav', 'fast-checkout', 'risk-scoring', 'smart-search'][i % 4])
    .replace('{flagState}', i % 2 === 0 ? 'enabled' : 'disabled')
    .replace('{limitState}', i % 17 === 0 ? 'throttled' : 'allowed')
    .replace('{client}', `client-${i % 300}`)
    .replace('{window}', String(30 + (i % 6) * 10))
    .replace('{provider}', ['stripe', 'adyen', 'paypal', 'internal'][i % 4])
    .replace('{operation}', ['authorize', 'capture', 'refund', 'void'][i % 4])
    .replace('{shard}', String(i % 128))
    .replace('{checkpoint}', String(1_000_000 + i));

  // Add predictable selective terms and very common terms for search-budget spot checks.
  if (i % 997 === 0) message += ` ${rareTokens[(i / 997) % rareTokens.length | 0]}`;
  if (i % 2 === 0) message += ' common-heartbeat';
  if (severity === 'error') message += ' exception stacktrace';
  return message;
}

async function initDb() {
  const start = Date.now();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_logs_ts_desc ON logs (ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts_desc ON logs (severity, ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_lower_message ON logs (lower(message));
  `);

  const countResult = await db.query('SELECT COUNT(*)::int AS count FROM logs');
  const existing = Number(countResult.rows[0]?.count || 0);
  if (existing === ROW_COUNT) {
    console.log(`PGLite ready with ${existing} seeded rows; skipped reseed (${Date.now() - start}ms)`);
    return;
  }

  console.log(`Seeding deterministic ${ROW_COUNT.toLocaleString()} row log corpus into ${DATA_DIR}...`);
  await db.exec('TRUNCATE TABLE logs');
  await db.exec('BEGIN');
  try {
    const baseMs = Date.UTC(2024, 0, 1, 0, 0, 0);
    const spanMs = 30 * 24 * 60 * 60 * 1000;
    for (let from = 1; from <= ROW_COUNT; from += BATCH_SIZE) {
      const to = Math.min(ROW_COUNT, from + BATCH_SIZE - 1);
      const params = [];
      const values = [];
      for (let id = from; id <= to; id++) {
        const severity = severityFor(id - 1);
        const service = services[(id - 1) % services.length];
        const ts = new Date(baseMs + Math.floor(((id - 1) / (ROW_COUNT - 1)) * spanMs)).toISOString();
        const message = makeMessage(id - 1, severity, service);
        const p = params.length;
        params.push(id, ts, severity, service, message);
        values.push(`($${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5})`);
      }
      await db.query(
        `INSERT INTO logs (id, ts, severity, service, message) VALUES ${values.join(',')}`,
        params
      );
      if ((to % 10_000) === 0) console.log(`  seeded ${to.toLocaleString()} rows`);
    }
    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
  console.log(`Seed complete in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

function parseLogQuery(query) {
  const offset = query.offset === undefined || query.offset === '' ? 0 : Number(query.offset);
  const limit = query.limit === undefined || query.limit === '' ? 100 : Number(query.limit);
  const severity = query.severity === undefined || query.severity === '' ? null : String(query.severity);
  const q = query.q === undefined || query.q === '' ? null : String(query.q);

  if (!Number.isInteger(offset) || offset < 0) return { error: 'offset must be a non-negative integer' };
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return { error: 'limit must be an integer from 1 to 200' };
  if (severity && !SEVERITIES.has(severity)) return { error: 'severity must be one of debug, info, warn, error' };
  if (q && q.length > 200) return { error: 'q must be at most 200 characters' };
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
    params.push(`%${q.toLowerCase()}%`);
    clauses.push(`lower(message) LIKE $${params.length}`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

const countCache = new Map();
const windowCache = new Map();
const MAX_WINDOW_CACHE_ENTRIES = 300;

function canonicalFilterKey({ severity, q }) {
  return JSON.stringify({ severity: severity || '', q: q ? q.toLowerCase() : '' });
}

function rememberWindow(key, value) {
  if (windowCache.has(key)) windowCache.delete(key);
  windowCache.set(key, value);
  while (windowCache.size > MAX_WINDOW_CACHE_ENTRIES) {
    const oldest = windowCache.keys().next().value;
    windowCache.delete(oldest);
  }
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/logs', async (req, res, next) => {
  try {
    const parsed = parseLogQuery(req.query);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const filterKey = canonicalFilterKey(parsed);
    const windowKey = `${filterKey}:${parsed.offset}:${parsed.limit}`;
    const cached = windowCache.get(windowKey);
    if (cached) return res.json(cached);

    const { where, params } = buildWhere(parsed);
    let total = countCache.get(filterKey);
    if (total === undefined) {
      const countResult = await db.query(`SELECT COUNT(*)::int AS total FROM logs ${where}`, params);
      total = Number(countResult.rows[0]?.total || 0);
      countCache.set(filterKey, total);
    }

    const rowsResult = await db.query(
      `
        SELECT id, ts, severity, service, message
        FROM logs
        ${where}
        ORDER BY ts DESC, id DESC
        OFFSET $${params.length + 1}
        LIMIT $${params.length + 2}
      `,
      [...params, parsed.offset, parsed.limit]
    );
    const payload = { total, rows: rowsResult.rows };
    rememberWindow(windowKey, payload);
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.get('/api/stats', async (_req, res, next) => {
  try {
    const [totalResult, severityResult] = await Promise.all([
      db.query('SELECT COUNT(*)::int AS total FROM logs'),
      db.query('SELECT severity, COUNT(*)::int AS count FROM logs GROUP BY severity')
    ]);
    const bySeverity = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const row of severityResult.rows) bySeverity[row.severity] = Number(row.count);
    res.json({ total: Number(totalResult.rows[0]?.total || 0), severity: bySeverity });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(__dirname, '..', 'dist')));
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'internal server error' });
});

await initDb();
app.listen(PORT, () => {
  console.log(`Log explorer API serving on http://localhost:${PORT}`);
});
