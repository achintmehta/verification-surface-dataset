import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', '.pglite-data');
const LOG_COUNT = 100_000;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;
const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const SERVICES = ['auth', 'billing', 'checkout', 'catalog', 'search', 'orders', 'payments', 'notifications'];

let db;
let cachedStats = null;
const totalCache = new Map();

function severityForIndex(i) {
  const n = i % 100;
  if (n < 60) return 'debug';
  if (n < 85) return 'info';
  if (n < 95) return 'warn';
  return 'error';
}

function logRowFor(id) {
  const i = id - 1;
  const latest = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
  const span = 30 * 24 * 60 * 60 * 1000;
  const ts = new Date(latest - Math.floor((i * span) / LOG_COUNT)).toISOString();
  const severity = severityForIndex(i);
  const service = SERVICES[i % SERVICES.length];
  const user = 1000 + ((i * 7919) % 9000);
  const requestId = `req-${String((i * 48271) % 1_000_000).padStart(6, '0')}`;
  const shard = (i * 17) % 32;
  const latency = 8 + ((i * 37) % 1400);
  const route = ['/login', '/api/cart', '/api/search', '/api/orders', '/api/payments', '/api/profile'][i % 6];
  const key = `cache:${service}:${(i * 13) % 2048}`;
  const upstream = ['postgres', 'redis', 'stripe', 'email-gateway', 'inventory', 'recommendations'][i % 6];

  let message;
  if (severity === 'info') {
    message = `request completed ${requestId} route=${route} user=${user} status=200 latency=${latency}ms shard=${shard}`;
  } else if (severity === 'debug') {
    message = `cache ${i % 3 === 0 ? 'hit' : 'miss'} key=${key} request=${requestId} diagnostic stage=${i % 7}`;
  } else if (severity === 'warn') {
    message = `retry scheduled for ${upstream} request=${requestId} attempt=${1 + (i % 4)} latency=${latency}ms backpressure=${i % 5 === 0}`;
  } else {
    message = `timeout contacting ${upstream} request=${requestId} status=503 latency=${latency}ms incident=${(i * 19) % 97}`;
  }

  // Deterministic rare and medium-selectivity fragments for substring-search tests.
  if (i % 997 === 0) message += ' trace-needle alpha';
  if (i % 89 === 0) message += ' reconciliation-marker';
  if (i % 11 === 0) message += ' region=us-east';
  if (i % 13 === 0) message += ' customer-tier=gold';

  return [id, ts, severity, service, message, message.toLowerCase()];
}

async function createSchema() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id integer PRIMARY KEY,
      ts timestamptz NOT NULL,
      severity text NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
      service text NOT NULL,
      message text NOT NULL,
      message_lc text NOT NULL DEFAULT ''
    );
    ALTER TABLE logs ADD COLUMN IF NOT EXISTS message_lc text NOT NULL DEFAULT '';
  `);
}

async function createIndexes() {
  await db.exec(`
    CREATE INDEX IF NOT EXISTS logs_ts_id_desc_idx ON logs (ts DESC, id ASC);
    CREATE INDEX IF NOT EXISTS logs_severity_ts_id_desc_idx ON logs (severity, ts DESC, id ASC);
    CREATE INDEX IF NOT EXISTS logs_message_lc_idx ON logs (message_lc);
  `);

  // If the bundled PGLite build supports pg_trgm, use it. The application still
  // functions correctly without it; the btree/order indexes cover the required
  // windowing shapes and pg_trgm accelerates arbitrary contains searches.
  try {
    await db.exec(`
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
      CREATE INDEX IF NOT EXISTS logs_message_trgm_idx ON logs USING gin (message_lc gin_trgm_ops);
    `);
  } catch (err) {
    console.warn('[db] pg_trgm extension unavailable; falling back to lower(message) LIKE scans for substring filters');
  }
}

async function seedLogs() {
  console.time('[db] seed');
  const batchSize = 1000;
  await db.exec('BEGIN');
  try {
    for (let first = 1; first <= LOG_COUNT; first += batchSize) {
      const last = Math.min(LOG_COUNT, first + batchSize - 1);
      const values = [];
      const placeholders = [];
      let parameter = 1;
      for (let id = first; id <= last; id++) {
        const row = logRowFor(id);
        values.push(...row);
        placeholders.push(`($${parameter++}, $${parameter++}, $${parameter++}, $${parameter++}, $${parameter++}, $${parameter++})`);
      }
      await db.query(
        `INSERT INTO logs (id, ts, severity, service, message, message_lc) VALUES ${placeholders.join(',')}`,
        values,
      );
    }
    await db.exec('COMMIT');
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }
  console.timeEnd('[db] seed');
}

async function initializeDatabase() {
  await mkdir(DATA_DIR, { recursive: true });
  db = new PGlite(DATA_DIR);
  await createSchema();

  const countResult = await db.query('SELECT COUNT(*)::int AS count FROM logs');
  const count = Number(countResult.rows[0]?.count || 0);

  const needsSeed = count !== LOG_COUNT
    || Number((await db.query("SELECT COUNT(*)::int AS count FROM logs WHERE message_lc = ''")).rows[0]?.count || 0) > 0
    || Number((await db.query("SELECT COUNT(*)::int AS count FROM logs WHERE severity = 'debug'")).rows[0]?.count || 0) !== 60000;

  if (needsSeed) {
    if (count !== 0) {
      console.warn(`[db] found ${count} stale or incomplete rows; resetting to deterministic ${LOG_COUNT}-row corpus`);
      await db.exec('TRUNCATE logs');
    }
    await seedLogs();
  } else {
    console.log(`[db] deterministic corpus already present (${count} rows); skipping seed`);
  }

  console.time('[db] indexes');
  await createIndexes();
  console.timeEnd('[db] indexes');
  await refreshStats();
}

async function refreshStats() {
  const result = await db.query(`
    SELECT severity, COUNT(*)::int AS count
    FROM logs
    GROUP BY severity
  `);
  const bySeverity = { debug: 0, info: 0, warn: 0, error: 0 };
  for (const row of result.rows) bySeverity[row.severity] = Number(row.count);
  cachedStats = {
    total: Object.values(bySeverity).reduce((sum, count) => sum + count, 0),
    severities: bySeverity,
  };
}

function parseIntegerParam(value, name, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (!/^\d+$/.test(String(value))) throw new Error(`${name} must be a non-negative integer`);
  return Number(value);
}

function escapeLike(raw) {
  return raw.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function normalizeQuery(req) {
  const offset = parseIntegerParam(req.query.offset, 'offset', 0);
  const limit = parseIntegerParam(req.query.limit, 'limit', DEFAULT_LIMIT);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be between 1 and ${MAX_LIMIT}`);
  }

  const severity = req.query.severity === undefined || req.query.severity === '' ? null : String(req.query.severity);
  if (severity !== null && !VALID_SEVERITIES.has(severity)) {
    throw new Error('severity must be one of debug, info, warn, error');
  }

  const q = req.query.q === undefined || req.query.q === null ? '' : String(req.query.q).trim();
  if (q.length > 200) throw new Error('q must be 200 characters or fewer');
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
    params.push(`%${escapeLike(q.toLowerCase())}%`);
    clauses.push(`message_lc LIKE $${params.length} ESCAPE '\\'`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function totalCacheKey({ severity, q }) {
  return `${severity || '*'}\u0000${q.toLowerCase()}`;
}

async function exactTotal(filters, where, params) {
  if (!filters.q && !filters.severity && cachedStats) return cachedStats.total;
  if (!filters.q && filters.severity && cachedStats) return cachedStats.severities[filters.severity];

  const key = totalCacheKey(filters);
  if (totalCache.has(key)) return totalCache.get(key);

  const countSql = `SELECT COUNT(*)::int AS total FROM logs ${where}`;
  const countResult = await db.query(countSql, params);
  const total = Number(countResult.rows[0]?.total || 0);
  totalCache.set(key, total);
  return total;
}

async function queryLogs(filters) {
  const { where, params } = buildWhere(filters);
  const total = await exactTotal(filters, where, params);

  const rowParams = [...params, filters.limit, filters.offset];
  const limitParameter = rowParams.length - 1;
  const offsetParameter = rowParams.length;
  const rowsSql = `
    SELECT id, ts, severity, service, message
    FROM logs
    ${where}
    ORDER BY ts DESC, id ASC
    LIMIT $${limitParameter} OFFSET $${offsetParameter}
  `;
  const rowsResult = await db.query(rowsSql, rowParams);
  return { total, rows: rowsResult.rows.slice(0, MAX_LIMIT) };
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ ok: true, rows: cachedStats?.total ?? null });
});

app.get('/api/stats', async (req, res, next) => {
  try {
    if (!cachedStats) await refreshStats();
    res.json(cachedStats);
  } catch (err) {
    next(err);
  }
});

app.get('/api/logs', async (req, res, next) => {
  const started = performance.now();
  try {
    const filters = normalizeQuery(req);
    const payload = await queryLogs(filters);
    res.set('X-Query-Time-Ms', String(Math.round((performance.now() - started) * 10) / 10));
    res.json(payload);
  } catch (err) {
    if (err.message?.includes('must be') || err.message?.includes('limit') || err.message?.includes('severity') || err.message?.includes('q ')) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[server] listening on http://localhost:${PORT}`);
      console.log(`[server] PGLite data directory: ${DATA_DIR}`);
    });
  })
  .catch((err) => {
    console.error('[server] failed to initialize database', err);
    process.exit(1);
  });
