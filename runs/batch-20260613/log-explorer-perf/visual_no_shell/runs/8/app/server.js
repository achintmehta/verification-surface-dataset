import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.PGLITE_DATA_DIR || './.pglite-data';
const ROW_COUNT = 100_000;
const BATCH_SIZE = 1000;
const LIMIT_CAP = 200;
const SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const SERVICES = ['auth-api', 'billing', 'checkout', 'catalog', 'notifications', 'search', 'orders', 'worker'];

const db = new PGlite(DB_PATH);
let statsCache = { total: 0, bySeverity: { debug: 0, info: 0, warn: 0, error: 0 } };
const countCache = new Map();

function severityFor(i) {
  // Deterministic 60/25/10/5 distribution in every 100-row band.
  const bucket = i % 100;
  if (bucket < 60) return 'info';
  if (bucket < 85) return 'debug';
  if (bucket < 95) return 'warn';
  return 'error';
}

const templates = [
  'request completed route={route} status={status} duration_ms={duration} trace={trace}',
  'cache {cacheResult} key={key} duration_ms={duration} trace={trace}',
  'database query {dbState} table={table} duration_ms={duration} trace={trace}',
  'payment workflow {paymentState} provider={provider} amount={amount} trace={trace}',
  'retry attempt={attempt} operation={operation} reason={reason} trace={trace}',
  'timeout while calling upstream={upstream} duration_ms={duration} trace={trace}',
  'user session {sessionState} account={account} ip={ip} trace={trace}',
  'queue job {jobState} queue={queue} attempt={attempt} trace={trace}',
  'feature flag evaluated flag={flag} variant={variant} account={account} trace={trace}',
  'validation {validationState} field={field} route={route} trace={trace}',
];

function pick(arr, n) { return arr[Math.abs(n) % arr.length]; }

function messageFor(i, service, severity) {
  const route = pick(['/login', '/cart', '/checkout', '/search', '/v1/orders', '/profile', '/health'], i);
  const status = severity === 'error' ? pick([500, 502, 503, 429], i) : severity === 'warn' ? pick([202, 304, 409, 429], i) : pick([200, 201, 204, 206], i);
  const vals = {
    route,
    status,
    duration: 5 + ((i * 37) % 2400),
    trace: `tr-${(0x10000000 + ((i * 2654435761) >>> 0)).toString(16)}`,
    cacheResult: pick(['hit', 'miss', 'stale', 'refresh'], i),
    key: `${service}:${(i * 17) % 5000}`,
    dbState: pick(['ok', 'slow', 'blocked', 'replanned'], i),
    table: pick(['users', 'orders', 'events', 'invoices', 'products'], i),
    paymentState: pick(['authorized', 'captured', 'declined', 'reconciled'], i),
    provider: pick(['stripe', 'adyen', 'paypal', 'internal-ledger'], i),
    amount: ((i * 13) % 9500) / 100,
    attempt: 1 + (i % 5),
    operation: pick(['fetch-profile', 'capture-payment', 'send-email', 'index-document', 'reserve-stock'], i),
    reason: pick(['rate_limit', 'connection_reset', 'deadlock', 'timeout', 'bad_gateway'], i),
    upstream: pick(['identity', 'inventory', 'ledger', 'email-gateway', 'recommendations'], i),
    sessionState: pick(['created', 'refreshed', 'expired', 'revoked'], i),
    account: `acct_${1000 + (i % 9000)}`,
    ip: `10.${(i >> 8) % 255}.${(i >> 4) % 255}.${i % 255}`,
    jobState: pick(['started', 'finished', 'deferred', 'failed'], i),
    queue: pick(['email', 'webhooks', 'indexing', 'exports'], i),
    flag: pick(['new-checkout', 'fast-search', 'risk-engine', 'dark-mode'], i),
    variant: pick(['control', 'a', 'b', 'holdout'], i),
    validationState: pick(['passed', 'failed', 'skipped'], i),
    field: pick(['email', 'postal_code', 'coupon', 'quantity'], i),
  };
  let msg = templates[i % templates.length];
  for (const [k, v] of Object.entries(vals)) msg = msg.replaceAll(`{${k}}`, String(v));
  // Add deterministic selective needles and a common term to exercise q performance.
  if (i % 997 === 0) msg += ' rare-needle incident-alpha';
  if (i % 67 === 0) msg += ' customer-visible';
  if (i % 3 === 0) msg += ' region=us-east common';
  return msg;
}

async function setupSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id integer PRIMARY KEY,
      ts timestamptz NOT NULL,
      severity text NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service text NOT NULL,
      message text NOT NULL,
      message_lc text NOT NULL
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_ts_desc ON logs (ts DESC, id ASC);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_severity_ts_desc ON logs (severity, ts DESC, id ASC);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_message_lc ON logs (message_lc);`);
}

async function existingCount() {
  const res = await db.query('SELECT count(*)::int AS count FROM logs');
  return Number(res.rows[0]?.count || 0);
}

async function seedIfNeeded() {
  const count = await existingCount();
  if (count === ROW_COUNT) {
    console.log(`[boot] Database already contains ${ROW_COUNT} log rows; skipping seed.`);
    return;
  }
  if (count !== 0) {
    console.log(`[boot] Found partial corpus (${count}); rebuilding deterministic seed.`);
    await db.query('TRUNCATE logs');
  }

  console.log(`[boot] Seeding ${ROW_COUNT} deterministic log rows in batches of ${BATCH_SIZE}...`);
  const seedStart = Date.now();
  await db.query('BEGIN');
  try {
    const base = Date.UTC(2026, 0, 31, 23, 59, 59);
    const spanMs = 30 * 24 * 60 * 60 * 1000;
    const stepMs = Math.floor(spanMs / ROW_COUNT);
    for (let start = 0; start < ROW_COUNT; start += BATCH_SIZE) {
      const values = [];
      const params = [];
      for (let j = 0; j < BATCH_SIZE && start + j < ROW_COUNT; j++) {
        const i = start + j;
        const id = i + 1; // id ascending is exactly ts descending.
        const ts = new Date(base - i * stepMs).toISOString();
        const severity = severityFor(i);
        const service = SERVICES[i % SERVICES.length];
        const message = messageFor(i, service, severity);
        const p = params.length;
        values.push(`($${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}, $${p + 6})`);
        params.push(id, ts, severity, service, message, message.toLowerCase());
      }
      await db.query(
        `INSERT INTO logs (id, ts, severity, service, message, message_lc) VALUES ${values.join(',')}`,
        params,
      );
      if ((start + BATCH_SIZE) % 10000 === 0) console.log(`[boot] Seeded ${start + BATCH_SIZE}/${ROW_COUNT}`);
    }
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
  await db.query('ANALYZE logs');
  console.log(`[boot] Seed complete in ${((Date.now() - seedStart) / 1000).toFixed(1)}s.`);
}

async function refreshStatsCache() {
  const sevResult = await db.query('SELECT severity, count(*)::int AS count FROM logs GROUP BY severity');
  const bySeverity = { debug: 0, info: 0, warn: 0, error: 0 };
  let total = 0;
  for (const row of sevResult.rows) {
    bySeverity[row.severity] = Number(row.count);
    total += Number(row.count);
  }
  statsCache = { total, bySeverity };
  countCache.clear();
  countCache.set('|', total);
  for (const [sev, count] of Object.entries(bySeverity)) countCache.set(`${sev}|`, count);
}

function parseNonNegativeInt(value, def, name) {
  if (value === undefined || value === '') return def;
  if (!/^\d+$/.test(String(value))) throw Object.assign(new Error(`${name} must be a non-negative integer`), { status: 400 });
  return Number(value);
}

function buildWhere({ severity, q }, params, options = {}) {
  const clauses = [];
  if (severity) {
    params.push(severity);
    clauses.push(`severity = $${params.length}`);
  }
  if (q) {
    if (options.prefixSearch) {
      // Token prefix clauses are indexable with the ordinary btree text index;
      // fall back to contains semantics otherwise.
      params.push(`${q.toLowerCase()}%`);
      clauses.push(`message_lc LIKE $${params.length}`);
    } else {
      params.push(`%${q.toLowerCase()}%`);
      clauses.push(`message_lc LIKE $${params.length}`);
    }
  }
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

async function exactTotalFor(query) {
  const key = `${query.severity}|${query.q}`;
  if (countCache.has(key)) return countCache.get(key);
  const params = [];
  const where = buildWhere(query, params);
  const result = await db.query(`SELECT count(*)::int AS total FROM logs ${where}`, params);
  const total = Number(result.rows[0]?.total || 0);
  countCache.set(key, total);
  return total;
}

function validateLogsQuery(req) {
  const offset = parseNonNegativeInt(req.query.offset, 0, 'offset');
  const limit = parseNonNegativeInt(req.query.limit, 100, 'limit');
  if (!Number.isSafeInteger(offset)) throw Object.assign(new Error('offset is too large'), { status: 400 });
  if (limit < 1) throw Object.assign(new Error('limit must be at least 1'), { status: 400 });
  if (limit > LIMIT_CAP) throw Object.assign(new Error(`limit must be <= ${LIMIT_CAP}`), { status: 400 });
  const severity = String(req.query.severity || '').trim().toLowerCase();
  if (severity && !SEVERITIES.has(severity)) throw Object.assign(new Error('unknown severity'), { status: 400 });
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 200);
  return { offset, limit, severity, q };
}

async function createApp() {
  await setupSchema();
  await seedIfNeeded();
  await refreshStatsCache();

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.get('/api/stats', (req, res) => {
    res.json(statsCache);
  });

  app.get('/api/logs', async (req, res, next) => {
    try {
      const query = validateLogsQuery(req);
      const total = await exactTotalFor(query);

      const rowParams = [];
      const whereForRows = buildWhere(query, rowParams);
      const safeOffset = Math.min(query.offset, total);
      rowParams.push(query.limit, safeOffset);
      const limitParam = rowParams.length - 1;
      const offsetParam = rowParams.length;
      const rowsSql = `
        SELECT id, ts, severity, service, message
        FROM logs
        ${whereForRows}
        ORDER BY ts DESC, id ASC
        LIMIT $${limitParam} OFFSET $${offsetParam}
      `;
      const rowsResult = await db.query(rowsSql, rowParams);
      res.set('Cache-Control', 'no-store');
      res.json({ total, rows: rowsResult.rows });
    } catch (err) { next(err); }
  });

  app.get('/src/main.js', async (req, res, next) => {
    try { res.type('application/javascript').send(await readFile(path.join(__dirname, 'src/main.js'), 'utf8')); }
    catch (err) { next(err); }
  });
  app.get('/src/styles.css', async (req, res, next) => {
    try { res.type('text/css').send(await readFile(path.join(__dirname, 'src/styles.css'), 'utf8')); }
    catch (err) { next(err); }
  });
  app.get('/favicon.ico', (req, res) => res.status(204).end());
  app.use(async (req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    try {
      res.type('html').send(await readFile(path.join(__dirname, 'index.html'), 'utf8'));
    } catch (err) { next(err); }
  });

  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || 'Internal Server Error' });
  });
  return app;
}

const bootStart = Date.now();
createApp().then(app => {
  app.listen(PORT, () => {
    console.log(`[boot] Serving on http://localhost:${PORT} after ${((Date.now() - bootStart) / 1000).toFixed(1)}s`);
  });
}).catch(err => {
  console.error('[boot] Failed to start', err);
  process.exit(1);
});
