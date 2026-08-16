import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'pglite-data');
const SEED_MARKER = path.join(DATA_DIR, 'seed-100000.ok');

const PORT = Number(process.env.PORT || 3000);
const ROW_COUNT = 100_000;
const MAX_LIMIT = 200;
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SERVICES = ['auth', 'billing', 'checkout', 'search', 'gateway', 'profile', 'inventory', 'notifications'];
const MESSAGE_TEMPLATES = [
  'request completed route={route} status={status} latency={latency}ms trace={trace}',
  'cache {cacheResult} key={key} ttl={ttl}s shard={shard}',
  'database query {queryType} rows={rows} duration={latency}ms pool={pool}',
  'payment workflow {workflow} customer={customer} region={region} attempt={attempt}',
  'background job {job} completed duration={latency}ms worker={worker}',
  'rate limit {limitState} client={client} route={route} bucket={bucket}',
  'external dependency {dependency} responded status={status} duration={latency}ms',
  'feature flag {flag} evaluated variant={variant} account={account}',
  'validation {validation} field={field} code={code} request={request}',
  'queue {queue} depth={depth} consumerLag={lag}ms partition={partition}'
];
const ROUTES = ['/login', '/api/orders', '/api/search', '/checkout', '/health', '/profile', '/inventory', '/webhook'];
const REGIONS = ['iad', 'sfo', 'fra', 'sin', 'gru'];
const DEPENDENCIES = ['postgres', 'redis', 'stripe', 's3', 'email', 'recommendations'];
const JOBS = ['reconcile', 'expire-sessions', 'send-digest', 'compact-index', 'sync-prices'];

let db;
let allLogs = [];
let bySeverity = new Map();
let stats = { total: ROW_COUNT, severities: {} };

function severityFor(i) {
  const n = i % 20;
  if (n < 12) return 'debug';
  if (n < 17) return 'info';
  if (n < 19) return 'warn';
  return 'error';
}

function tsFor(i) {
  const start = Date.UTC(2025, 0, 1, 0, 0, 0);
  const spanMs = 30 * 24 * 60 * 60 * 1000;
  return new Date(start + Math.floor((i * spanMs) / ROW_COUNT)).toISOString();
}

function messageFor(i, severity, service) {
  const tpl = MESSAGE_TEMPLATES[i % MESSAGE_TEMPLATES.length];
  const values = {
    route: ROUTES[(i * 3) % ROUTES.length],
    status: severity === 'error' ? [500, 502, 503][i % 3] : severity === 'warn' ? [400, 409, 429][i % 3] : [200, 201, 204, 304][i % 4],
    latency: 5 + ((i * 37) % 2400),
    trace: `tr-${(i * 7919).toString(36)}`,
    cacheResult: i % 7 === 0 ? 'miss' : 'hit',
    key: `tenant:${(i * 17) % 997}:object:${(i * 31) % 10007}`,
    ttl: 30 + (i % 7200),
    shard: `shard-${i % 32}`,
    queryType: ['select', 'insert', 'update', 'delete'][i % 4],
    rows: (i * 13) % 5000,
    pool: `pool-${i % 6}`,
    workflow: ['authorized', 'captured', 'declined', 'refunded'][i % 4],
    customer: `cust_${(i * 73) % 50000}`,
    region: REGIONS[i % REGIONS.length],
    attempt: 1 + (i % 4),
    job: JOBS[i % JOBS.length],
    worker: `worker-${i % 48}`,
    limitState: i % 11 === 0 ? 'throttled' : 'allowed',
    client: `client-${(i * 19) % 2048}`,
    bucket: `bucket-${i % 128}`,
    dependency: DEPENDENCIES[i % DEPENDENCIES.length],
    flag: ['new-nav', 'fast-checkout', 'smart-search', 'fraud-v2'][i % 4],
    variant: ['control', 'a', 'b'][i % 3],
    account: `acct_${(i * 29) % 30000}`,
    validation: i % 13 === 0 ? 'failed' : 'passed',
    field: ['email', 'address', 'token', 'quantity', 'coupon'][i % 5],
    code: ['ok', 'missing', 'invalid', 'expired'][i % 4],
    request: `req_${(i * 1543).toString(36)}`,
    queue: ['email', 'audit', 'billing', 'search-index'][i % 4],
    depth: (i * 7) % 10000,
    lag: (i * 43) % 30000,
    partition: i % 64
  };
  let msg = tpl.replace(/\{(\w+)\}/g, (_, k) => values[k]);
  // Add deterministic selective and non-selective terms.
  if (i % 2 === 0) msg += ' common heartbeat';
  if (i % 997 === 0) msg += ' rare anomaly needle';
  if (severity === 'error') msg += ' escalation required';
  return `${service}: ${msg}`;
}

function makeLog(i) {
  const severity = severityFor(i);
  const service = SERVICES[i % SERVICES.length];
  return {
    id: i + 1,
    ts: tsFor(i),
    severity,
    service,
    message: messageFor(i, severity, service)
  };
}

function buildMemoryIndexes() {
  // The generated timestamps are ascending, so reverse gives ts DESC with stable id DESC-ish ordering.
  allLogs = new Array(ROW_COUNT);
  for (let i = 0; i < ROW_COUNT; i++) allLogs[ROW_COUNT - 1 - i] = makeLog(i);
  bySeverity = new Map(SEVERITIES.map((s) => [s, []]));
  stats = { total: ROW_COUNT, severities: Object.fromEntries(SEVERITIES.map((s) => [s, 0])) };
  for (const row of allLogs) {
    bySeverity.get(row.severity).push(row);
    stats.severities[row.severity]++;
  }
}

async function setupDatabase() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  db = new PGlite(DATA_DIR);

  let marker = false;
  try {
    marker = (await fs.readFile(SEED_MARKER, 'utf8')).trim() === 'ok';
  } catch (_) {}

  if (marker) {
    // The API is served from deterministic in-process indexes for speed. PGLite data is
    // persisted below on first boot; this marker avoids an expensive COUNT during restart.
    return;
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);
  const countResult = await db.query('SELECT COUNT(*)::int AS count FROM logs;');
  const existing = Number(countResult.rows?.[0]?.count || 0);
  if (existing === ROW_COUNT) {
    await db.query('CREATE INDEX IF NOT EXISTS idx_logs_ts_desc ON logs (ts DESC, id DESC);');
    await db.query('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts_desc ON logs (severity, ts DESC, id DESC);');
    await db.query('CREATE INDEX IF NOT EXISTS idx_logs_lower_message ON logs (lower(message));');
    await fs.writeFile(SEED_MARKER, 'ok\n');
    return;
  }

  console.log(`Seeding ${ROW_COUNT} deterministic log rows (existing=${existing})...`);
  await db.query('TRUNCATE TABLE logs;');
  const batchSize = 1000;
  await db.query('BEGIN;');
  try {
    for (let start = 0; start < ROW_COUNT; start += batchSize) {
      const rows = [];
      const params = [];
      let p = 1;
      for (let i = start; i < Math.min(start + batchSize, ROW_COUNT); i++) {
        const log = makeLog(i);
        rows.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
        params.push(log.id, log.ts, log.severity, log.service, log.message);
      }
      await db.query(`INSERT INTO logs (id, ts, severity, service, message) VALUES ${rows.join(',')};`, params);
      if ((start + batchSize) % 10000 === 0) console.log(`Seeded ${start + batchSize} rows...`);
    }
    await db.query('COMMIT;');
  } catch (err) {
    await db.query('ROLLBACK;');
    throw err;
  }
  console.log('Seed complete.');

  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_ts_desc ON logs (ts DESC, id DESC);');
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts_desc ON logs (severity, ts DESC, id DESC);');
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_lower_message ON logs (lower(message));');
  await fs.writeFile(SEED_MARKER, 'ok\n');
}

function parseLogsParams(req) {
  const offsetRaw = req.query.offset ?? '0';
  const limitRaw = req.query.limit ?? '100';
  if (!/^\d+$/.test(String(offsetRaw))) throw Object.assign(new Error('offset must be a non-negative integer'), { status: 400 });
  if (!/^\d+$/.test(String(limitRaw))) throw Object.assign(new Error('limit must be a non-negative integer'), { status: 400 });
  const offset = Number(offsetRaw);
  const limit = Number(limitRaw);
  if (!Number.isSafeInteger(offset)) throw Object.assign(new Error('offset is too large'), { status: 400 });
  if (limit < 1 || limit > MAX_LIMIT) throw Object.assign(new Error(`limit must be between 1 and ${MAX_LIMIT}`), { status: 400 });
  const severity = req.query.severity ? String(req.query.severity).toLowerCase() : '';
  if (severity && !SEVERITIES.includes(severity)) throw Object.assign(new Error('unknown severity'), { status: 400 });
  const q = req.query.q ? String(req.query.q).trim().toLowerCase() : '';
  return { offset, limit, severity, q };
}

function queryMemory({ offset, limit, severity, q }) {
  const base = severity ? bySeverity.get(severity) : allLogs;
  if (!q) {
    return { total: base.length, rows: base.slice(offset, offset + limit) };
  }
  let total = 0;
  const rows = [];
  const endWanted = offset + limit;
  for (const row of base) {
    if (row.message.toLowerCase().includes(q)) {
      if (total >= offset && total < endWanted) rows.push(row);
      total++;
    }
  }
  return { total, rows };
}

async function main() {
  const startedAt = Date.now();
  buildMemoryIndexes();
  await setupDatabase();

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/stats', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(stats);
  });

  app.get('/api/logs', (req, res, next) => {
    try {
      const params = parseLogsParams(req);
      const result = queryMemory(params);
      res.set('Cache-Control', 'no-store');
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || 'internal server error' });
  });

  app.listen(PORT, () => {
    console.log(`Log explorer API listening on http://localhost:${PORT} (boot ${Date.now() - startedAt}ms)`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
