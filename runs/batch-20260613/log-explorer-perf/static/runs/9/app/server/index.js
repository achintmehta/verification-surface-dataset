import express from 'express';
import cors from 'cors';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const dataDir = resolve(rootDir, '.pglite-data');
const PORT = Number(process.env.PORT || 3000);
const ROW_COUNT = 100_000;
const BATCH_SIZE = 1_000;
const MAX_LIMIT = 200;
const SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);

let db;
let cachedStats = null;

const services = [
  'auth-api',
  'billing-worker',
  'checkout',
  'edge-gateway',
  'inventory',
  'notification',
  'search',
  'user-profile'
];

const templates = {
  debug: [
    'trace request_id={rid} tenant={tenant} route={route} cache={cache}',
    'cache probe key={key} shard={shard} result={cache}',
    'scheduler heartbeat worker={worker} queue={queue} lag={lag}ms',
    'feature flag evaluation flag={flag} tenant={tenant} variant={variant}'
  ],
  info: [
    'request completed route={route} status={status} latency={latency}ms request_id={rid}',
    'job completed queue={queue} worker={worker} duration={latency}ms items={items}',
    'customer action tenant={tenant} user={user} action={action} request_id={rid}',
    'upstream call service={upstream} status={status} latency={latency}ms'
  ],
  warn: [
    'retry scheduled operation={operation} attempt={attempt} reason={reason} request_id={rid}',
    'slow query detected table={table} duration={latency}ms rows={items}',
    'rate limit near threshold tenant={tenant} route={route} remaining={remaining}',
    'queue backlog growing queue={queue} depth={items} lag={lag}ms'
  ],
  error: [
    'operation failed operation={operation} error={error} request_id={rid}',
    'upstream timeout service={upstream} route={route} timeout={timeout}ms request_id={rid}',
    'database conflict table={table} transaction={rid} error={error}',
    'message delivery failed queue={queue} target={upstream} error={error}'
  ]
};

function pick(arr, n) {
  return arr[Math.abs(n) % arr.length];
}

function severityFor(i) {
  const bucket = i % 100;
  if (bucket < 60) return 'debug';
  if (bucket < 85) return 'info';
  if (bucket < 95) return 'warn';
  return 'error';
}

function pad(num, width) {
  return String(num).padStart(width, '0');
}

function makeMessage(i, severity, service) {
  const replacements = {
    rid: `req-${pad((i * 2654435761) >>> 0, 10)}`,
    tenant: `tenant-${pad((i * 17) % 250, 3)}`,
    route: pick(['/api/login', '/api/orders', '/api/search', '/api/cart', '/api/profile', '/health', '/webhook/payment'], i),
    cache: pick(['hit', 'miss', 'stale', 'bypass'], Math.floor(i / 3)),
    key: `key-${pad((i * 31) % 5000, 4)}`,
    shard: `shard-${i % 32}`,
    worker: `worker-${pad(i % 64, 2)}`,
    queue: pick(['email', 'payments', 'indexing', 'audit', 'exports', 'critical'], i),
    lag: String((i * 7) % 1500),
    flag: pick(['new-checkout', 'fast-search', 'dark-mode', 'risk-engine'], i),
    variant: pick(['control', 'a', 'b', 'disabled'], i),
    status: String(pick([200, 201, 202, 204, 304, 400, 401, 404, 409, 429, 500, 502], i)),
    latency: String(5 + ((i * 13) % 2500)),
    items: String(1 + ((i * 19) % 10000)),
    user: `user-${pad((i * 23) % 20000, 5)}`,
    action: pick(['created', 'updated', 'deleted', 'viewed', 'exported', 'invited'], i),
    upstream: pick(services, i + 3),
    operation: pick(['charge-card', 'sync-account', 'refresh-token', 'rebuild-index', 'send-email', 'reserve-stock'], i),
    attempt: String(1 + (i % 5)),
    reason: pick(['timeout', 'deadlock', 'rate-limit', 'connection-reset', 'temporary-unavailable'], i),
    table: pick(['users', 'orders', 'payments', 'sessions', 'events', 'inventory'], i),
    remaining: String((i * 29) % 1000),
    error: pick(['ECONNRESET', 'ETIMEDOUT', 'SERIALIZATION_FAILURE', 'VALIDATION_FAILED', 'UPSTREAM_502'], i),
    timeout: String(100 + ((i * 11) % 4000))
  };
  const template = pick(templates[severity], Math.floor(i / 5));
  return `${service} ${template.replace(/\{(\w+)\}/g, (_, key) => replacements[key] ?? '')}`;
}

function makeRow(i) {
  // One row every ~25.92 seconds spans exactly 30 days across 100k rows.
  const end = Date.UTC(2025, 0, 31, 23, 59, 59);
  const ts = new Date(end - i * 25_920).toISOString();
  const severity = severityFor(i);
  const service = services[i % services.length];
  return [i + 1, ts, severity, service, makeMessage(i, severity, service)];
}

async function initDb() {
  await mkdir(dataDir, { recursive: true });
  db = new PGlite(dataDir);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL,
      message_lc TEXT NOT NULL
    );
  `);

  const countResult = await db.query('SELECT COUNT(*)::int AS count FROM logs');
  const existing = Number(countResult.rows[0]?.count || 0);
  if (existing === ROW_COUNT) {
    console.log(`PGLite corpus already contains ${ROW_COUNT} rows; skipping seed.`);
  } else {
    if (existing > 0) {
      console.warn(`Found ${existing} log rows; rebuilding deterministic ${ROW_COUNT} row corpus.`);
      await db.exec('TRUNCATE logs');
    }
    await seedLogs();
  }

  await db.exec(`
    CREATE INDEX IF NOT EXISTS logs_ts_desc_idx ON logs (ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS logs_severity_ts_desc_idx ON logs (severity, ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS logs_message_lc_idx ON logs (message_lc);
  `);

  await refreshStats();
}

async function seedLogs() {
  const started = Date.now();
  console.log(`Seeding ${ROW_COUNT.toLocaleString()} deterministic log rows...`);
  await db.exec('BEGIN');
  try {
    for (let start = 0; start < ROW_COUNT; start += BATCH_SIZE) {
      const values = [];
      const placeholders = [];
      const end = Math.min(start + BATCH_SIZE, ROW_COUNT);
      for (let i = start; i < end; i++) {
        const row = makeRow(i);
        const base = values.length;
        values.push(...row, row[4].toLowerCase());
        placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
      }
      await db.query(
        `INSERT INTO logs (id, ts, severity, service, message, message_lc) VALUES ${placeholders.join(',')}`,
        values
      );
      if ((start / BATCH_SIZE) % 10 === 9) {
        console.log(`  inserted ${end.toLocaleString()} rows`);
      }
    }
    await db.exec('COMMIT');
    console.log(`Seed finished in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
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
    total: Object.values(bySeverity).reduce((sum, n) => sum + n, 0),
    severities: bySeverity
  };
}

function parseLogsQuery(query) {
  const rawOffset = query.offset ?? '0';
  const rawLimit = query.limit ?? '100';
  if (!/^\d+$/.test(String(rawOffset)) || !/^\d+$/.test(String(rawLimit))) {
    return { error: 'offset and limit must be non-negative integers' };
  }
  const offset = Number(rawOffset);
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(offset) || offset < 0) return { error: 'offset must be a non-negative integer' };
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return { error: `limit must be between 1 and ${MAX_LIMIT}` };
  }
  const severity = typeof query.severity === 'string' ? query.severity.trim().toLowerCase() : '';
  if (severity && !SEVERITIES.has(severity)) return { error: 'unknown severity' };
  const q = typeof query.q === 'string' ? query.q.trim() : '';
  if (q.length > 200) return { error: 'q must be 200 characters or fewer' };
  return { offset, limit, severity, q };
}

function escapeLike(value) {
  return value.toLowerCase().replace(/[\\%_]/g, ch => `\\${ch}`);
}

function buildWhere({ severity, q }) {
  const conditions = [];
  const params = [];
  if (severity) {
    params.push(severity);
    conditions.push(`severity = $${params.length}`);
  }
  if (q) {
    params.push(`%${escapeLike(q)}%`);
    conditions.push(`message_lc LIKE $${params.length} ESCAPE '\\'`);
  }
  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params
  };
}

function fastKnownTotal({ severity, q }) {
  if (!cachedStats || q) return null;
  return severity ? cachedStats.severities[severity] : cachedStats.total;
}

function mapLog(row) {
  return {
    id: Number(row.id),
    ts: row.ts instanceof Date ? row.ts.toISOString() : row.ts,
    severity: row.severity,
    service: row.service,
    message: row.message
  };
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/stats', (_req, res) => {
  res.json(cachedStats);
});

app.get('/api/logs', async (req, res, next) => {
  try {
    const parsed = parseLogsQuery(req.query);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const { where, params } = buildWhere(parsed);
    let total = fastKnownTotal(parsed);
    if (total === null) {
      const countResult = await db.query(`SELECT COUNT(*)::int AS total FROM logs ${where}`, params);
      total = Number(countResult.rows[0]?.total || 0);
    }

    const rowParams = [...params, parsed.limit, parsed.offset];
    const limitParam = rowParams.length - 1;
    const offsetParam = rowParams.length;
    const rowsResult = await db.query(
      `SELECT id, ts, severity, service, message
       FROM logs
       ${where}
       ORDER BY ts DESC, id DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      rowParams
    );

    res.json({ total, rows: rowsResult.rows.map(mapLog) });
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
    app.listen(PORT, () => {
      console.log(`Log explorer API listening on http://localhost:${PORT}`);
    });
  })
  .catch(error => {
    console.error('Failed to initialize server:', error);
    process.exit(1);
  });
