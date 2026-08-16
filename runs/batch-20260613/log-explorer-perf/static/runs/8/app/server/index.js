import express from 'express';
import cors from 'cors';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const dataDir = process.env.PGLITE_DATA_DIR || join(rootDir, 'pglite-data');
const PORT = Number(process.env.PORT || 3000);
const ROW_COUNT = 100_000;
const BATCH_SIZE = 1_000;
const ALLOWED_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

const services = [
  'auth-api',
  'billing-worker',
  'catalog-api',
  'checkout-api',
  'email-sender',
  'inventory-sync',
  'search-indexer',
  'web-gateway'
];

const commonTemplates = [
  'request completed for tenant {tenant} route {route} status {status} latency {latency}ms trace {trace}',
  'cache lookup for key {key} returned {cacheResult} in {latency}ms trace {trace}',
  'job {job} processed partition {partition} batch {batch} duration {latency}ms trace {trace}',
  'database query {query} completed rows {rows} duration {latency}ms trace {trace}',
  'feature flag {flag} evaluated as {flagState} for tenant {tenant} trace {trace}',
  'heartbeat from node {node} region {region} load {load} trace {trace}'
];

const warnTemplates = [
  'retry scheduled for dependency {dependency} attempt {attempt} backoff {backoff}ms tenant {tenant} trace {trace}',
  'slow request detected route {route} latency {latency}ms threshold {threshold}ms trace {trace}',
  'queue depth high for {queue} depth {depth} partition {partition} trace {trace}',
  'rate limit nearing capacity for tenant {tenant} route {route} remaining {remaining} trace {trace}'
];

const errorTemplates = [
  'dependency {dependency} timeout after {latency}ms route {route} tenant {tenant} trace {trace}',
  'payment authorization failed code {errorCode} tenant {tenant} order {orderId} trace {trace}',
  'database transaction rolled back reason {reason} query {query} trace {trace}',
  'message delivery failed mailbox {mailbox} provider {provider} error {errorCode} trace {trace}'
];

function pad(value, width) {
  return String(value).padStart(width, '0');
}

function deterministicSeverity(i) {
  const bucket = (i * 37) % 100;
  if (bucket < 60) return 'debug';
  if (bucket < 85) return 'info';
  if (bucket < 95) return 'warn';
  return 'error';
}

function templateFor(severity, i) {
  if (severity === 'error') return errorTemplates[(i * 7) % errorTemplates.length];
  if (severity === 'warn') return warnTemplates[(i * 5) % warnTemplates.length];
  return commonTemplates[(i * 11) % commonTemplates.length];
}

function renderMessage(template, i) {
  const replacements = {
    tenant: `tenant-${pad((i * 13) % 500, 3)}`,
    route: ['/api/login', '/api/cart', '/api/search', '/api/orders', '/api/profile', '/api/checkout'][(i * 17) % 6],
    status: [200, 201, 202, 204, 304, 400, 401, 404][(i * 19) % 8],
    latency: 5 + ((i * 23) % 2995),
    trace: `trace-${pad(i, 6)}-${pad((i * 7919) % 100000, 5)}`,
    key: `session:${pad((i * 29) % 20000, 5)}`,
    cacheResult: ['hit', 'miss', 'stale'][(i * 31) % 3],
    job: ['reconcile', 'compact', 'notify', 'hydrate', 'audit'][(i * 41) % 5],
    partition: (i * 43) % 64,
    batch: pad((i * 47) % 10000, 4),
    query: ['selectUser', 'updateOrder', 'listProducts', 'insertEvent', 'refreshToken'][(i * 53) % 5],
    rows: (i * 59) % 2500,
    flag: ['new-nav', 'fast-checkout', 'risk-score', 'dark-mode'][(i * 61) % 4],
    flagState: ['enabled', 'disabled'][(i * 67) % 2],
    node: `node-${pad((i * 71) % 128, 3)}`,
    region: ['us-east', 'us-west', 'eu-central', 'ap-south'][(i * 73) % 4],
    load: `${((i * 79) % 100).toFixed(0)}%`,
    dependency: ['postgres', 'redis', 'stripe', 's3', 'openai', 'smtp'][(i * 83) % 6],
    attempt: 1 + ((i * 89) % 5),
    backoff: 50 + ((i * 97) % 5000),
    threshold: 250 + ((i * 101) % 1250),
    queue: ['events', 'mail', 'payments', 'indexing'][(i * 103) % 4],
    depth: (i * 107) % 50000,
    remaining: (i * 109) % 1000,
    errorCode: ['E_TIMEOUT', 'E_CONN_RESET', 'E_VALIDATION', 'E_PROVIDER_429'][(i * 113) % 4],
    orderId: `ord-${pad((i * 127) % 80000, 5)}`,
    reason: ['deadlock', 'constraint_violation', 'serialization_failure', 'client_abort'][(i * 131) % 4],
    mailbox: `user${pad((i * 137) % 20000, 5)}@example.test`,
    provider: ['ses', 'sendgrid', 'mailgun'][(i * 139) % 3]
  };
  return template.replace(/\{(\w+)\}/g, (_, key) => replacements[key] ?? key);
}

function makeRow(i) {
  const severity = deterministicSeverity(i);
  const service = services[(i * 17) % services.length];
  const startMs = Date.UTC(2024, 0, 1, 0, 0, 0);
  const spanMs = 30 * 24 * 60 * 60 * 1000;
  const ts = new Date(startMs + Math.floor((i * spanMs) / ROW_COUNT)).toISOString();
  const message = renderMessage(templateFor(severity, i), i);
  return [i + 1, ts, severity, service, message];
}

async function initializeDatabase() {
  await mkdir(dataDir, { recursive: true });
  const db = new PGlite(dataDir);

  await db.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id integer PRIMARY KEY,
      ts timestamp NOT NULL,
      severity text NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
      service text NOT NULL,
      message text NOT NULL
    )
  `);

  const countResult = await db.query('SELECT COUNT(*)::int AS count FROM logs');
  const existingCount = Number(countResult.rows[0]?.count || 0);

  if (existingCount !== ROW_COUNT) {
    if (existingCount > 0) {
      console.warn(`Existing log table has ${existingCount} rows; rebuilding deterministic ${ROW_COUNT}-row corpus.`);
      await db.query('TRUNCATE TABLE logs');
    }
    console.time('seed');
    await db.query('BEGIN');
    try {
      for (let start = 0; start < ROW_COUNT; start += BATCH_SIZE) {
        const size = Math.min(BATCH_SIZE, ROW_COUNT - start);
        const params = [];
        const values = [];
        for (let j = 0; j < size; j += 1) {
          const row = makeRow(start + j);
          params.push(...row);
          const base = j * 5;
          values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
        }
        await db.query(
          `INSERT INTO logs (id, ts, severity, service, message) VALUES ${values.join(',')}`,
          params
        );
      }
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
    console.timeEnd('seed');
  } else {
    console.log(`Log corpus already seeded (${existingCount} rows).`);
  }

  console.time('index');
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_ts_desc_id_desc ON logs (ts DESC, id DESC)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts_desc_id_desc ON logs (severity, ts DESC, id DESC)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_lower_message ON logs (lower(message))');
  await db.query('ANALYZE logs');
  console.timeEnd('index');

  return db;
}

function parseIntegerParam(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value))) {
    const error = new Error(`${name} must be a non-negative integer`);
    error.status = 400;
    throw error;
  }
  return Number(value);
}

function parseLogQuery(query) {
  const offset = parseIntegerParam(query.offset, 0, 'offset');
  const limit = parseIntegerParam(query.limit, 100, 'limit');
  if (limit < 1 || limit > MAX_LIMIT) {
    const error = new Error(`limit must be between 1 and ${MAX_LIMIT}`);
    error.status = 400;
    throw error;
  }
  const severity = query.severity === undefined || query.severity === '' ? null : String(query.severity);
  if (severity !== null && !ALLOWED_SEVERITIES.has(severity)) {
    const error = new Error('severity must be one of debug, info, warn, error');
    error.status = 400;
    throw error;
  }
  const q = query.q === undefined ? '' : String(query.q).trim();
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
    params.push(`%${q.toLowerCase().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`);
    clauses.push(`lower(message) LIKE $${params.length} ESCAPE '\\'`);
  }
  return {
    sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params
  };
}

function createApp(db) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/stats', async (_req, res, next) => {
    try {
      const result = await db.query(`
        SELECT severity, COUNT(*)::int AS count
        FROM logs
        GROUP BY severity
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

  app.get('/api/logs', async (req, res, next) => {
    try {
      const parsed = parseLogQuery(req.query);
      const where = buildWhere(parsed);
      const countSql = `SELECT COUNT(*)::int AS total FROM logs ${where.sql}`;
      const rowParams = [...where.params, parsed.limit, parsed.offset];
      const limitPosition = where.params.length + 1;
      const offsetPosition = where.params.length + 2;
      const rowsSql = `
        SELECT id, ts, severity, service, message
        FROM logs
        ${where.sql}
        ORDER BY ts DESC, id DESC
        LIMIT $${limitPosition} OFFSET $${offsetPosition}
      `;

      const countResult = await db.query(countSql, where.params);
      const rowsResult = await db.query(rowsSql, rowParams);

      res.json({
        total: Number(countResult.rows[0]?.total || 0),
        rows: rowsResult.rows.slice(0, MAX_LIMIT)
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: error.message || 'Internal Server Error' });
  });

  return app;
}

const db = await initializeDatabase();
const app = createApp(db);
app.listen(PORT, () => {
  console.log(`Log explorer API listening on http://localhost:${PORT}`);
});
