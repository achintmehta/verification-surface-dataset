import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data', 'pglite');
const PORT = Number(process.env.PORT || 3000);
const ROW_COUNT = 100_000;
const MAX_LIMIT = 200;
const SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const SERVICES = [
  'auth', 'billing', 'checkout', 'catalog',
  'search', 'gateway', 'worker', 'notifications'
];

const templates = [
  'request completed path=/api/{path} status={status} trace={trace} latency={latency}ms customer={customer}',
  'database query {query} duration={latency}ms rows={rows} cache={cache} trace={trace}',
  'retry attempt={attempt} operation={operation} shard={shard} reason={reason} trace={trace}',
  'queue processed topic={topic} partition={partition} lag={lag} event={event} trace={trace}',
  'feature flag={flag} variant={variant} account={customer} trace={trace}',
  'upstream call service={upstream} status={status} latency={latency}ms endpoint=/{path} trace={trace}',
  'validation {outcome} field={field} request={request} customer={customer} trace={trace}',
  'cache lookup key={cacheKey} result={cache} ttl={ttl}s trace={trace}',
  'security audit action={action} principal=user-{user} ip=10.{octet}.{shard}.{host} trace={trace}',
  'batch job={job} phase={phase} processed={rows} lag={lag} trace={trace}'
];

const paths = ['login', 'orders', 'cart', 'products', 'search', 'profile', 'payments', 'webhook'];
const operations = ['charge-card', 'issue-token', 'reserve-stock', 'send-email', 'sync-profile', 'reindex'];
const reasons = ['timeout', 'deadlock', 'rate-limit', 'connection-reset', 'backpressure', 'stale-version'];
const topics = ['orders', 'invoices', 'clicks', 'emails', 'audit', 'inventory'];
const events = ['created', 'updated', 'deleted', 'published', 'acknowledged', 'compacted'];
const fields = ['email', 'amount', 'sku', 'address', 'session', 'signature'];

function severityFor(i) {
  const n = i % 100;
  if (n < 60) return 'debug';
  if (n < 85) return 'info';
  if (n < 95) return 'warn';
  return 'error';
}

function pick(list, i, salt = 0) {
  return list[(i * 17 + salt * 31) % list.length];
}

function messageFor(i, severity, service) {
  const t = templates[i % templates.length];
  const status = severity === 'error' ? pick(['500', '502', '503', '504'], i) :
    severity === 'warn' ? pick(['202', '304', '409', '429'], i) : pick(['200', '201', '204'], i);
  const cache = i % 7 === 0 ? 'miss' : 'hit';
  const outcome = severity === 'error' ? 'failed' : (i % 13 === 0 ? 'rejected' : 'accepted');
  return t
    .replace('{path}', pick(paths, i))
    .replace('{status}', status)
    .replace('{trace}', `tr-${(0x100000 + ((i * 2654435761) >>> 0)).toString(16)}`)
    .replace('{latency}', String(5 + ((i * 37) % (severity === 'error' ? 1800 : severity === 'warn' ? 700 : 180))))
    .replace('{customer}', `cust-${(i * 97) % 5000}`)
    .replace('{query}', pick(['select-user', 'insert-order', 'update-ledger', 'search-index', 'load-session'], i))
    .replace('{rows}', String(1 + ((i * 19) % 2500)))
    .replace('{cache}', cache)
    .replace('{attempt}', String(1 + (i % 5)))
    .replace('{operation}', pick(operations, i))
    .replace('{shard}', String(i % 64))
    .replace('{reason}', pick(reasons, i))
    .replace('{topic}', pick(topics, i))
    .replace('{partition}', String(i % 24))
    .replace('{lag}', String((i * 23) % 9000))
    .replace('{event}', pick(events, i))
    .replace('{flag}', pick(['new-nav', 'fast-checkout', 'risk-engine', 'recommendations', 'dark-mode'], i))
    .replace('{variant}', pick(['control', 'blue', 'green', 'canary'], i))
    .replace('{upstream}', pick(SERVICES, i, 2))
    .replace('{outcome}', outcome)
    .replace('{field}', pick(fields, i))
    .replace('{request}', `req-${i.toString().padStart(6, '0')}`)
    .replace('{cacheKey}', `${service}:${pick(paths, i)}:${i % 1000}`)
    .replace('{ttl}', String(30 + (i % 1200)))
    .replace('{action}', pick(['login', 'logout', 'token-refresh', 'permission-check', 'password-reset'], i))
    .replace('{user}', String((i * 13) % 20000))
    .replace('{octet}', String(i % 255))
    .replace('{host}', String((i * 7) % 255))
    .replace('{job}', pick(['nightly-rollup', 'retention-sweep', 'email-digest', 'fraud-scan'], i))
    .replace('{phase}', pick(['start', 'scan', 'write', 'verify', 'complete'], i));
}

async function initDb() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const db = new PGlite(DATA_DIR);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);

  const countResult = await db.query('SELECT COUNT(*)::int AS count FROM logs');
  const existing = Number(countResult.rows[0]?.count || 0);
  if (existing !== ROW_COUNT) {
    if (existing > 0) {
      console.log(`Found ${existing} log rows, rebuilding deterministic corpus...`);
      await db.exec('TRUNCATE logs');
    } else {
      console.log('Seeding deterministic 100,000-row log corpus...');
    }
    await seed(db);
  } else {
    console.log('Log corpus already seeded; skipping seed.');
  }

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts_desc ON logs (ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts_desc ON logs (severity, ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_lower_message ON logs (lower(message));
    ANALYZE logs;
  `);
  return db;
}

async function seed(db) {
  const start = Date.UTC(2026, 0, 1, 0, 0, 0);
  const span = 30 * 24 * 60 * 60 * 1000;
  const batchSize = 1000;
  await db.exec('BEGIN');
  try {
    for (let begin = 1; begin <= ROW_COUNT; begin += batchSize) {
      const end = Math.min(ROW_COUNT, begin + batchSize - 1);
      const values = [];
      const params = [];
      let p = 1;
      for (let id = begin; id <= end; id++) {
        const i = id - 1;
        const sev = severityFor(i);
        const service = SERVICES[(i * 11) % SERVICES.length];
        const ts = new Date(start + Math.floor((i * span) / ROW_COUNT)).toISOString();
        const msg = messageFor(i, sev, service);
        values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
        params.push(id, ts, sev, service, msg);
      }
      await db.query(`INSERT INTO logs (id, ts, severity, service, message) VALUES ${values.join(',')}`, params);
      if (end % 10000 === 0) console.log(`Seeded ${end.toLocaleString()} rows...`);
    }
    await db.exec('COMMIT');
    console.log('Seed complete.');
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }
}

function parseLogQuery(req) {
  const offsetRaw = req.query.offset ?? '0';
  const limitRaw = req.query.limit ?? '100';
  if (!/^\d+$/.test(String(offsetRaw)) || !/^\d+$/.test(String(limitRaw))) {
    return { error: 'offset and limit must be non-negative integers' };
  }
  const offset = Number(offsetRaw);
  const limit = Number(limitRaw);
  if (!Number.isSafeInteger(offset) || offset < 0) return { error: 'offset must be non-negative' };
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { error: `limit must be between 1 and ${MAX_LIMIT}` };
  const severity = req.query.severity ? String(req.query.severity).toLowerCase() : '';
  if (severity && !SEVERITIES.has(severity)) return { error: 'unknown severity' };
  const q = req.query.q == null ? '' : String(req.query.q).trim();
  if (q.length > 200) return { error: 'q must be at most 200 characters' };
  return { offset, limit, severity, q };
}

function buildWhere({ severity, q }, params) {
  const clauses = [];
  if (severity) {
    params.push(severity);
    clauses.push(`severity = $${params.length}`);
  }
  if (q) {
    params.push(`%${q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`);
    clauses.push(`lower(message) LIKE $${params.length} ESCAPE '\\'`);
  }
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

const db = await initDb();
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(ROOT, 'dist')));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/stats', async (_req, res, next) => {
  try {
    const [totalResult, sevResult] = await Promise.all([
      db.query('SELECT COUNT(*)::int AS total FROM logs'),
      db.query('SELECT severity, COUNT(*)::int AS count FROM logs GROUP BY severity')
    ]);
    const bySeverity = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const row of sevResult.rows) bySeverity[row.severity] = Number(row.count);
    res.json({ total: Number(totalResult.rows[0].total), severities: bySeverity });
  } catch (err) { next(err); }
});

app.get('/api/logs', async (req, res, next) => {
  try {
    const parsed = parseLogQuery(req);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const countParams = [];
    const where = buildWhere(parsed, countParams);
    const rowsParams = [...countParams, parsed.limit, parsed.offset];
    const limitPos = rowsParams.length - 1;
    const offsetPos = rowsParams.length;

    const [countResult, rowsResult] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total FROM logs ${where}`, countParams),
      db.query(
        `SELECT id, ts, severity, service, message
         FROM logs ${where}
         ORDER BY ts DESC, id DESC
         LIMIT $${limitPos} OFFSET $${offsetPos}`,
        rowsParams
      )
    ]);
    res.json({ total: Number(countResult.rows[0].total), rows: rowsResult.rows });
  } catch (err) { next(err); }
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(ROOT, 'dist', 'index.html'), (err) => {
    if (err) res.status(404).send('Build the client with Vite or run npm run client for development.');
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

app.listen(PORT, () => {
  console.log(`Log explorer API listening on http://localhost:${PORT}`);
});
