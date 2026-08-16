import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'pglite-data');
const PORT = Number(process.env.PORT || 3000);
const ROW_COUNT = 100_000;
const PUBLIC_ROOT = ROOT;
const BATCH_SIZE = 5000;
const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);

const services = ['auth', 'billing', 'gateway', 'orders', 'inventory', 'search', 'notifications', 'worker'];
const templates = [
  'request completed for tenant {tenant} path {path} in {ms}ms trace={trace}',
  'cache {cacheStatus} for key {key} tenant {tenant} trace={trace}',
  'database query {queryType} took {ms}ms rows={rows} trace={trace}',
  'user session {sessionAction} for user {user} from {ip} trace={trace}',
  'payment provider {provider} returned status {status} for invoice {invoice} trace={trace}',
  'queue job {job} {jobStatus} after {ms}ms attempt={attempt} trace={trace}',
  'feature flag {flag} evaluated as {decision} for tenant {tenant} trace={trace}',
  'external api {api} responded {status} latency={ms}ms trace={trace}',
  'validation {validation} on field {field} for request {request} trace={trace}',
  'background maintenance {task} scanned partition {partition} trace={trace}'
];
const paths = ['/api/login', '/api/orders', '/api/search', '/api/cart', '/api/payments', '/api/profile'];
const words = {
  cacheStatus: ['hit', 'miss', 'stale', 'bypass'],
  queryType: ['select', 'insert', 'update', 'delete'],
  sessionAction: ['created', 'refreshed', 'expired', 'revoked'],
  provider: ['stripe', 'adyen', 'paypal', 'internal-ledger'],
  status: ['200', '201', '202', '400', '404', '409', '429', '500'],
  job: ['email-digest', 'reindex', 'webhook', 'invoice-sync', 'thumbnail'],
  jobStatus: ['completed', 'retrying', 'failed', 'scheduled'],
  flag: ['new-checkout', 'fast-search', 'risk-engine', 'dark-mode'],
  decision: ['enabled', 'disabled', 'control', 'variant-b'],
  api: ['risk', 'tax', 'shipping', 'crm', 'analytics'],
  validation: ['passed', 'failed', 'skipped'],
  field: ['email', 'amount', 'sku', 'address', 'token'],
  task: ['vacuum', 'rollup', 'snapshot', 'compaction'],
  partition: ['north', 'south', 'east', 'west', 'central']
};

function sevFor(i) {
  const n = i % 100;
  if (n < 60) return 'debug';
  if (n < 85) return 'info';
  if (n < 95) return 'warn';
  return 'error';
}
function pick(arr, seed) { return arr[Math.abs(seed) % arr.length]; }
function trace(i) { return (0x10000000 + ((i * 2654435761) >>> 0)).toString(16).slice(-8); }
function buildMessage(i) {
  const template = templates[i % templates.length];
  const vals = {
    tenant: `tenant-${(i % 250) + 1}`,
    path: pick(paths, i * 3),
    ms: 5 + ((i * 37) % 2500),
    trace: trace(i),
    cacheStatus: pick(words.cacheStatus, i),
    key: `key-${i % 1200}`,
    rows: (i * 13) % 1000,
    queryType: pick(words.queryType, i),
    sessionAction: pick(words.sessionAction, i),
    user: `user-${(i * 17) % 50000}`,
    ip: `10.${i % 255}.${(i * 7) % 255}.${(i * 19) % 255}`,
    provider: pick(words.provider, i),
    status: pick(words.status, i),
    invoice: `inv-${100000 + i}`,
    job: pick(words.job, i),
    jobStatus: pick(words.jobStatus, i),
    attempt: 1 + (i % 5),
    flag: pick(words.flag, i),
    decision: pick(words.decision, i),
    api: pick(words.api, i),
    validation: pick(words.validation, i),
    field: pick(words.field, i),
    request: `req-${trace(i * 11)}`,
    task: pick(words.task, i),
    partition: pick(words.partition, i)
  };
  return template.replace(/\{(\w+)\}/g, (_, k) => vals[k]);
}
function escapeSql(s) { return String(s).replaceAll("'", "''"); }
function rowSql(i) {
  const base = Date.UTC(2024, 0, 1, 0, 0, 0);
  const span = 30 * 24 * 60 * 60 * 1000;
  const ts = new Date(base + Math.floor((i - 1) * span / ROW_COUNT)).toISOString();
  return `(${i}, '${ts}', '${sevFor(i)}', '${services[i % services.length]}', '${escapeSql(buildMessage(i))}', '${escapeSql(buildMessage(i).toLowerCase())}')`;
}

await fs.mkdir(DATA_DIR, { recursive: true });
const db = new PGlite(DATA_DIR);

async function initDb() {
  const started = Date.now();
  console.log('Initializing PGLite database...');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id integer PRIMARY KEY,
      ts timestamp NOT NULL,
      severity text NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service text NOT NULL,
      message text NOT NULL,
      message_lc text NOT NULL
    );
  `);
  const countRes = await db.query('SELECT COUNT(*)::int AS count FROM logs');
  const existing = Number(countRes.rows[0]?.count || 0);
  if (existing !== ROW_COUNT) {
    if (existing > 0) {
      console.log(`Found ${existing} rows, rebuilding deterministic corpus...`);
      await db.exec('TRUNCATE logs');
    } else {
      console.log('Seeding deterministic 100,000 row corpus...');
    }
    await db.exec('BEGIN');
    try {
      for (let start = 1; start <= ROW_COUNT; start += BATCH_SIZE) {
        const end = Math.min(ROW_COUNT, start + BATCH_SIZE - 1);
        const values = [];
        for (let i = start; i <= end; i++) values.push(rowSql(i));
        await db.exec(`INSERT INTO logs (id, ts, severity, service, message, message_lc) VALUES ${values.join(',')}`);
        if (end % 25000 === 0 || end === ROW_COUNT) console.log(`Seeded ${end}/${ROW_COUNT}`);
      }
      await db.exec('COMMIT');
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }
  } else {
    console.log('Corpus already present; skipping seed.');
  }
  console.log('Ensuring indexes...');
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts_desc ON logs (ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts_desc ON logs (severity, ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_message_lc ON logs (message_lc);
  `);
  console.log(`Database ready in ${Date.now() - started}ms`);
}

function parseLogsQuery(req, res, next) {
  const offsetRaw = req.query.offset ?? '0';
  const limitRaw = req.query.limit ?? '100';
  const offset = Number(offsetRaw);
  const limit = Number(limitRaw);
  const severity = req.query.severity ? String(req.query.severity) : '';
  const q = req.query.q ? String(req.query.q).trim() : '';
  if (!Number.isInteger(offset) || offset < 0) return res.status(400).json({ error: 'offset must be a non-negative integer' });
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return res.status(400).json({ error: 'limit must be an integer between 1 and 200' });
  if (severity && !VALID_SEVERITIES.has(severity)) return res.status(400).json({ error: 'unknown severity' });
  if (q.length > 200) return res.status(400).json({ error: 'q is too long' });
  req.logQuery = { offset, limit, severity, q };
  next();
}

function whereFor({ severity, q }) {
  const clauses = [];
  const params = [];
  if (severity) { params.push(severity); clauses.push(`severity = $${params.length}`); }
  if (q) { params.push(`%${q.toLowerCase()}%`); clauses.push(`message_lc LIKE $${params.length}`); }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_ROOT, 'index.html')));
app.get('/src/:file', (req, res) => res.sendFile(path.join(PUBLIC_ROOT, 'src', req.params.file)));

app.get('/api/stats', async (req, res, next) => {
  try {
    const r = await db.query(`
      SELECT severity, COUNT(*)::int AS count FROM logs GROUP BY severity
      UNION ALL
      SELECT 'total' AS severity, COUNT(*)::int AS count FROM logs
    `);
    const severities = { debug: 0, info: 0, warn: 0, error: 0 };
    let total = 0;
    for (const row of r.rows) {
      if (row.severity === 'total') total = Number(row.count);
      else severities[row.severity] = Number(row.count);
    }
    res.json({ total, severities });
  } catch (e) { next(e); }
});

app.get('/api/logs', parseLogsQuery, async (req, res, next) => {
  try {
    const { offset, limit } = req.logQuery;
    const { where, params } = whereFor(req.logQuery);
    const countSql = `SELECT COUNT(*)::int AS total FROM logs ${where}`;
    const rowsSql = `SELECT id, ts, severity, service, message FROM logs ${where} ORDER BY ts DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    const [countResult, rowsResult] = await Promise.all([
      db.query(countSql, params),
      db.query(rowsSql, [...params, limit, offset])
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({ total: Number(countResult.rows[0]?.total || 0), rows: rowsResult.rows });
  } catch (e) { next(e); }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

await initDb();
app.listen(PORT, () => console.log(`Log explorer API listening on http://localhost:${PORT}`));
