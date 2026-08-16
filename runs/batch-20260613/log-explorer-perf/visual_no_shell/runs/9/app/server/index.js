import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { PGlite } from '@electric-sql/pglite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const DB_DIR = process.env.PGLITE_DATA_DIR || path.join(ROOT, '.pglite-data');
const ROWS = 100_000;
const SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const SERVICES = ['auth', 'billing', 'checkout', 'search', 'notify', 'profile', 'inventory', 'gateway'];
const SEVERITY_WEIGHTS = ['debug', 'debug', 'debug', 'debug', 'debug', 'debug', 'info', 'info', 'info', 'warn', 'error'];
const COMPONENTS = ['cache', 'queue', 'worker', 'database', 'router', 'scheduler', 'replica', 'validator', 'client', 'indexer'];
const REGIONS = ['iad', 'sfo', 'fra', 'sin', 'gru'];
const TEMPLATES = [
  'request completed route=/api/{service}/{bucket} latency={latency}ms tenant={tenant} trace={trace}',
  'cache {cacheResult} key={service}:{bucket}:{tenant} ttl={ttl}s trace={trace}',
  'database query {dbResult} table={component}_events rows={rows} latency={latency}ms trace={trace}',
  'background job {jobResult} queue={service}-{component} attempt={attempt} trace={trace}',
  'rate limit {limitResult} principal=user-{tenant} route=/v1/{service} trace={trace}',
  'dependency {depResult} upstream={component}.{region}.internal latency={latency}ms trace={trace}',
  'validation {validationResult} field={component}_id payload_size={bytes} trace={trace}',
  'retry policy {retryResult} operation={service}.{component} attempt={attempt} trace={trace}'
];

let db;

function pick(arr, n) { return arr[n % arr.length]; }
function stableHash(n) {
  let x = n >>> 0;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  return x >>> 0;
}
function severityFor(i) {
  // Deterministic rough 60/25/10/5 distribution.
  const r = i % 100;
  if (r < 60) return 'debug';
  if (r < 85) return 'info';
  if (r < 95) return 'warn';
  return 'error';
}
function messageFor(i, service, severity) {
  const h = stableHash(i * 2654435761);
  const component = pick(COMPONENTS, h);
  const region = pick(REGIONS, h >>> 4);
  const template = pick(TEMPLATES, h >>> 8);
  const latency = 5 + (h % (severity === 'error' ? 2500 : severity === 'warn' ? 900 : 180));
  const tenant = 1000 + (h % 900);
  const trace = (h.toString(16).padStart(8, '0') + (i * 97).toString(16).padStart(8, '0')).slice(0, 16);
  const bucket = ['login', 'cart', 'invoice', 'document', 'session', 'catalog', 'token', 'order'][(h >>> 12) % 8];
  const token = i % 997 === 0 ? ' needle=rare-signal' : i % 17 === 0 ? ' token=timeout' : i % 7 === 0 ? ' status=success' : '';
  const words = {
    service, component, region, latency, tenant, trace, bucket,
    ttl: 30 + (h % 7000), rows: h % 420,
    attempt: 1 + (h % 5), bytes: 128 + (h % 4096),
    cacheResult: i % 13 === 0 ? 'miss' : 'hit',
    dbResult: severity === 'error' ? 'failed' : 'completed',
    jobResult: severity === 'warn' ? 'delayed' : severity === 'error' ? 'failed' : 'completed',
    limitResult: severity === 'warn' ? 'throttled' : 'checked',
    depResult: severity === 'error' ? 'unavailable' : i % 19 === 0 ? 'slow' : 'ok',
    validationResult: severity === 'error' ? 'rejected' : 'passed',
    retryResult: severity === 'error' ? 'exhausted' : i % 11 === 0 ? 'scheduled' : 'not-needed'
  };
  return template.replace(/\{(\w+)\}/g, (_, k) => words[k]) + token;
}
function sqlQuote(value) {
  return String(value).replaceAll("'", "''");
}

async function initDb() {
  db = new PGlite(DB_DIR);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id integer PRIMARY KEY,
      ts timestamp NOT NULL,
      severity text NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service text NOT NULL,
      message text NOT NULL,
      message_lc text GENERATED ALWAYS AS (lower(message)) STORED
    );
  `);

  const countResult = await db.query('SELECT count(*)::int AS count FROM logs');
  const existing = Number(countResult.rows[0]?.count || 0);
  if (existing !== ROWS) {
    if (existing > 0) {
      console.log(`Found ${existing} rows, reseeding deterministic ${ROWS} row corpus...`);
      await db.exec('TRUNCATE logs');
    } else {
      console.log(`Seeding deterministic ${ROWS} row log corpus...`);
    }
    const start = Date.now();
    await seedLogs();
    console.log(`Seeded ${ROWS} rows in ${Date.now() - start}ms`);
  } else {
    console.log(`PGLite corpus already contains ${ROWS} rows; skipping seed.`);
  }

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts_desc ON logs (ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts_desc ON logs (severity, ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_message_lc ON logs (message_lc);
  `);
}

async function seedLogs() {
  const batchSize = 2500;
  const base = Date.UTC(2026, 0, 31, 23, 59, 59);
  const span = 30 * 24 * 60 * 60 * 1000;
  await db.exec('BEGIN');
  try {
    for (let start = 1; start <= ROWS; start += batchSize) {
      const values = [];
      const end = Math.min(ROWS, start + batchSize - 1);
      for (let id = start; id <= end; id++) {
        const severity = severityFor(id - 1);
        const service = SERVICES[(stableHash(id) + id) % SERVICES.length];
        // Newest row has the largest timestamp; evenly spans exactly 30 days with tiny jitter.
        const age = Math.floor(((id - 1) / (ROWS - 1)) * span);
        const tsMs = base - age;
        const ts = new Date(tsMs).toISOString();
        const message = messageFor(id, service, severity);
        values.push(`(${id}, '${ts}', '${severity}', '${service}', '${sqlQuote(message)}')`);
      }
      await db.exec(`INSERT INTO logs (id, ts, severity, service, message) VALUES ${values.join(',')}`);
    }
    await db.exec('COMMIT');
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }
}

function parseLogsParams(req, res) {
  const offsetRaw = req.query.offset ?? '0';
  const limitRaw = req.query.limit ?? '100';
  if (!/^\d+$/.test(String(offsetRaw)) || !/^\d+$/.test(String(limitRaw))) {
    res.status(400).json({ error: 'offset and limit must be non-negative integers' });
    return null;
  }
  const offset = Number(offsetRaw);
  const limit = Number(limitRaw);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    res.status(400).json({ error: 'offset must be a non-negative integer' });
    return null;
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    res.status(400).json({ error: 'limit must be between 1 and 200' });
    return null;
  }
  const severity = req.query.severity ? String(req.query.severity) : '';
  if (severity && !SEVERITIES.has(severity)) {
    res.status(400).json({ error: 'unknown severity' });
    return null;
  }
  const q = req.query.q ? String(req.query.q).trim().toLowerCase().slice(0, 200) : '';
  return { offset, limit, severity, q };
}

function buildWhere({ severity, q }) {
  const conditions = [];
  const params = [];
  if (severity) {
    params.push(severity);
    conditions.push(`severity = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`message_lc LIKE $${params.length}`);
  }
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

async function main() {
  const bootStart = Date.now();
  await initDb();

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.get('/api/logs', async (req, res, next) => {
    try {
      const parsed = parseLogsParams(req, res);
      if (!parsed) return;
      const { where, params } = buildWhere(parsed);
      const totalPromise = db.query(`SELECT count(*)::int AS total FROM logs ${where}`, params);
      const rowParams = [...params, parsed.limit, parsed.offset];
      // The seed is deliberately monotonic: lower id == newer timestamp. Ordering by
      // id ASC is therefore identical to ts DESC, id DESC and lets PostgreSQL/PGLite
      // use the compact primary-key btree for deep windows instead of sorting rows.
      const rowsPromise = db.query(
        `SELECT id, ts, severity, service, message
           FROM logs ${where}
          ORDER BY id ASC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        rowParams
      );
      const [totalResult, rowsResult] = await Promise.all([totalPromise, rowsPromise]);
      res.set('Cache-Control', 'no-store');
      res.json({ total: Number(totalResult.rows[0]?.total || 0), rows: rowsResult.rows });
    } catch (err) { next(err); }
  });

  app.get('/api/stats', async (req, res, next) => {
    try {
      const [total, sev] = await Promise.all([
        db.query('SELECT count(*)::int AS total FROM logs'),
        db.query('SELECT severity, count(*)::int AS count FROM logs GROUP BY severity')
      ]);
      const bySeverity = { debug: 0, info: 0, warn: 0, error: 0 };
      for (const row of sev.rows) bySeverity[row.severity] = Number(row.count);
      res.json({ total: Number(total.rows[0]?.total || 0), severity: bySeverity });
    } catch (err) { next(err); }
  });

  const publicDir = path.join(ROOT, 'dist');
  app.use(express.static(publicDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(publicDir, 'index.html'), err => {
      if (err) res.status(404).send('Run `npm run client` for the Vite dev UI, or build the frontend.');
    });
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  app.listen(PORT, () => {
    console.log(`Log explorer API listening on http://localhost:${PORT} (boot ${Date.now() - bootStart}ms)`);
  });
}

main().catch(err => {
  console.error('Failed to start log explorer', err);
  process.exit(1);
});
