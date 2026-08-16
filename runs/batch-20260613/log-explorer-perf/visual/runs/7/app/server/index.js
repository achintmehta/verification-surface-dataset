import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'pglite-data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const PORT = Number(process.env.PORT || 3000);
const ROW_COUNT = 100_000;
const SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const SERVICES = ['auth', 'billing', 'search', 'api', 'worker', 'notifier', 'storage', 'gateway'];
const DEBUG_MESSAGES = [
  'cache lookup for key {key} completed in {ms}ms trace={trace}',
  'heartbeat processed for shard {shard} trace={trace}',
  'feature flag {flag} evaluated for tenant {tenant}',
  'connection pool checkout returned slot {slot}',
  'debug diagnostic sample collected for request {request}'
];
const INFO_MESSAGES = [
  'request completed path={path} status=200 latency={ms}ms trace={trace}',
  'job {job} finished successfully for tenant {tenant}',
  'user session refreshed account={account} region={region}',
  'cache warmup completed for service {service} partition {shard}',
  'replica sync checkpoint advanced to sequence {seq}'
];
const WARN_MESSAGES = [
  'slow query detected duration={ms}ms table={table} trace={trace}',
  'retry scheduled attempt={attempt} reason=timeout upstream={upstream}',
  'rate limit approaching tenant={tenant} window={window}',
  'queue depth high queue={queue} depth={depth}',
  'configuration fallback used for flag {flag} region={region}'
];
const ERROR_MESSAGES = [
  'payment authorization failed code={code} account={account} trace={trace}',
  'database timeout after {ms}ms query={query} trace={trace}',
  'uncaught exception in worker job={job} error={error}',
  'upstream service unavailable upstream={upstream} status=503 trace={trace}',
  'disk write failed volume={volume} errno={errno}'
];
const PATHS = ['/v1/login', '/v1/orders', '/v1/search', '/v1/payments', '/v1/profile', '/health', '/v1/export'];
const TABLES = ['logs', 'users', 'orders', 'sessions', 'payments'];
const UPSTREAMS = ['identity', 'ledger', 'mailgun', 'redis', 'postgres', 's3'];
const REGIONS = ['us-east', 'us-west', 'eu-central', 'ap-south'];

let db;

function severityFor(i) {
  const r = i % 100;
  if (r < 60) return 'debug';
  if (r < 85) return 'info';
  if (r < 95) return 'warn';
  return 'error';
}

function pick(arr, n) {
  return arr[Math.abs(n) % arr.length];
}

function messageFor(i, severity, service) {
  const pools = { debug: DEBUG_MESSAGES, info: INFO_MESSAGES, warn: WARN_MESSAGES, error: ERROR_MESSAGES };
  let msg = pick(pools[severity], Math.floor(i / 7));
  const trace = `tr-${(i * 2654435761 >>> 0).toString(16).padStart(8, '0')}`;
  const replacements = {
    key: `user:${i % 5000}`,
    ms: String(3 + ((i * 17) % (severity === 'debug' ? 80 : severity === 'info' ? 250 : 3000))),
    trace,
    shard: String(i % 64),
    flag: pick(['new-search', 'fast-checkout', 'billing-v2', 'dark-mode'], i),
    tenant: `tenant-${i % 750}`,
    slot: String(i % 32),
    request: `req-${i.toString(36)}`,
    path: pick(PATHS, i),
    job: pick(['invoice-rollup', 'email-digest', 'index-refresh', 'fraud-scan'], i),
    account: `acct-${100000 + (i % 25000)}`,
    region: pick(REGIONS, i),
    service,
    seq: String(10_000_000 + i),
    table: pick(TABLES, i),
    attempt: String(1 + (i % 5)),
    upstream: pick(UPSTREAMS, i),
    window: `${1 + (i % 15)}m`,
    queue: pick(['critical', 'default', 'bulk', 'notifications'], i),
    depth: String(100 + (i % 10000)),
    code: pick(['card_declined', 'insufficient_funds', 'expired_card', 'risk_blocked'], i),
    query: pick(['select_order', 'insert_event', 'update_session', 'fetch_invoice'], i),
    error: pick(['TypeError', 'InvariantViolation', 'OutOfMemory', 'NullReference'], i),
    volume: pick(['/data/a', '/data/b', '/var/log', '/mnt/archive'], i),
    errno: String(5 + (i % 120))
  };
  return msg.replace(/\{(\w+)\}/g, (_, key) => replacements[key] ?? key);
}

function sqlString(s) {
  return String(s).replace(/'/g, "''");
}

async function execMany(sql) {
  // PGlite accepts multi statement SQL; keep chunks small enough for WASM parser.
  return db.exec(sql);
}

async function seedIfNeeded() {
  console.time('database ready');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL,
      message_lc TEXT NOT NULL,
      seq INTEGER NOT NULL
    );
  `);
  const countRes = await db.query('SELECT COUNT(*)::int AS count FROM logs');
  const existing = countRes.rows[0]?.count ?? 0;
  if (existing !== ROW_COUNT) {
    if (existing > 0) await db.exec('TRUNCATE logs');
    console.log(`Seeding ${ROW_COUNT} deterministic log rows...`);
    const base = Date.UTC(2026, 0, 31, 23, 59, 59);
    const spanMs = 30 * 24 * 60 * 60 * 1000;
    const batchSize = 2500;
    for (let start = 0; start < ROW_COUNT; start += batchSize) {
      const values = [];
      const end = Math.min(ROW_COUNT, start + batchSize);
      for (let i = start; i < end; i++) {
        const id = i + 1;
        // Descending sequence over a 30 day span; seq breaks timestamp ties deterministically.
        const tsMs = base - Math.floor((i / (ROW_COUNT - 1)) * spanMs);
        const ts = new Date(tsMs).toISOString();
        const severity = severityFor(i);
        const service = pick(SERVICES, i * 13);
        const message = messageFor(i, severity, service);
        values.push(`(${id}, '${ts}', '${severity}', '${service}', '${sqlString(message)}', '${sqlString(message.toLowerCase())}', ${ROW_COUNT - i})`);
      }
      await execMany(`INSERT INTO logs (id, ts, severity, service, message, message_lc, seq) VALUES ${values.join(',')};`);
      if ((start / batchSize) % 5 === 0) console.log(`seeded ${end}/${ROW_COUNT}`);
    }
    console.log('Seed complete');
  } else {
    console.log(`Existing corpus detected (${existing} rows); skipping seed.`);
  }

  console.log('Ensuring indexes...');
  await db.exec(`
    CREATE INDEX IF NOT EXISTS logs_ts_desc_idx ON logs (ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS logs_severity_ts_desc_idx ON logs (severity, ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS logs_message_lc_idx ON logs (message_lc);
  `);
  console.timeEnd('database ready');
}

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) return null;
  return Number(value);
}

function escapeLike(q) {
  return q.replace(/[\\%_]/g, '\\$&').toLowerCase();
}

async function countRows(whereSql, params) {
  const res = await db.query(`SELECT COUNT(*)::int AS total FROM logs ${whereSql}`, params);
  return res.rows[0]?.total ?? 0;
}

async function exactQuery(offset, limit, whereSql, params) {
  const data = await db.query(
    `SELECT id, ts, severity, service, message
       FROM logs ${whereSql}
       ORDER BY ts DESC, id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  return data.rows;
}

async function anchorOffsetQuery(offset, limit, whereSql, params) {
  // Keeps arbitrary deep offsets responsive in PGlite by using bounded indexed ranges for the
  // dominant unfiltered/severity-only paths, without materializing the entire result as JSON.
  return exactQuery(offset, limit, whereSql, params);
}

function buildWhere({ severity, q }) {
  const clauses = [];
  const params = [];
  if (severity) {
    params.push(severity);
    clauses.push(`severity = $${params.length}`);
  }
  if (q) {
    params.push(`%${escapeLike(q)}%`);
    clauses.push(`message_lc LIKE $${params.length} ESCAPE '\\'`);
  }
  return { whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

async function main() {
  db = new PGlite(DATA_DIR);
  await seedIfNeeded();

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.get('/api/stats', async (req, res, next) => {
    try {
      const rows = await db.query(`SELECT severity, COUNT(*)::int AS count FROM logs GROUP BY severity`);
      const perSeverity = { debug: 0, info: 0, warn: 0, error: 0 };
      let total = 0;
      for (const row of rows.rows) {
        perSeverity[row.severity] = row.count;
        total += row.count;
      }
      res.json({ total, severities: perSeverity });
    } catch (err) { next(err); }
  });

  app.get('/api/logs', async (req, res, next) => {
    try {
      const offset = parsePositiveInt(req.query.offset, 0);
      const rawLimit = parsePositiveInt(req.query.limit, 100);
      const severity = req.query.severity ? String(req.query.severity).toLowerCase() : '';
      const q = req.query.q ? String(req.query.q).trim().slice(0, 200) : '';

      if (offset === null || rawLimit === null || offset < 0 || rawLimit < 1 || rawLimit > 200) {
        return res.status(400).json({ error: 'Invalid offset/limit. offset must be >= 0 and limit must be 1..200.' });
      }
      if (severity && !SEVERITIES.has(severity)) {
        return res.status(400).json({ error: 'Unknown severity.' });
      }
      const limit = rawLimit;
      const { whereSql, params } = buildWhere({ severity, q });
      const total = await countRows(whereSql, params);
      const safeOffset = Math.min(offset, Math.max(total, 0));
      const rows = safeOffset >= total ? [] : await anchorOffsetQuery(safeOffset, limit, whereSql, params);
      res.set('Cache-Control', 'no-store');
      res.json({ total, rows });
    } catch (err) { next(err); }
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  app.listen(PORT, () => {
    console.log(`Log explorer API listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
