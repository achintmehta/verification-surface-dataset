import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const DB_DIR = process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', 'data', 'pglite');
const ROW_COUNT = 100_000;
const BATCH_SIZE = 1000;
const MAX_LIMIT = 200;
const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);

const services = [
  'api-gateway',
  'auth-service',
  'billing-worker',
  'checkout-api',
  'inventory',
  'notification',
  'search-indexer',
  'user-profile'
];

const messageTemplates = [
  'request completed for route {route} status {status} latency {latency}ms trace {trace}',
  'cache {cache_action} key {key} tenant {tenant} latency {latency}ms',
  'database query {query_type} on {table} completed in {latency}ms rows {rows}',
  'received event {event} from partition {partition} lag {lag}ms trace {trace}',
  'retry {retry} for upstream {upstream} due to {reason} trace {trace}',
  'validated payload for account {account} feature {feature} status {status}',
  'background job {job} completed duration {latency}ms worker {worker}',
  'rate limit check for client {client} result {limit_result} quota {quota}',
  'cold start avoided by warm pool for service {service} region {region}',
  'security audit action {action} actor {account} resource {resource}'
];

function pick(arr, n) {
  return arr[n % arr.length];
}

function severityFor(i) {
  // Deterministic debug/info/warn/error 60/25/10/5 distribution in every block of 20.
  const mod = i % 20;
  if (mod < 12) return 'debug';
  if (mod < 17) return 'info';
  if (mod < 19) return 'warn';
  return 'error';
}

function severityRank(severity) {
  return severity === 'debug' ? 0 : severity === 'info' ? 1 : severity === 'warn' ? 2 : 3;
}

function buildMessage(i, severity, service) {
  const template = pick(messageTemplates, i * 7 + Math.floor(i / 97));
  const values = {
    route: pick(['/v1/login', '/v1/orders', '/v1/search', '/v1/users', '/v1/payments', '/internal/health'], i),
    status: pick(['200', '201', '204', '400', '401', '404', '409', '429', '500', '503'], i * 3),
    latency: String(5 + ((i * 37) % 2400)),
    trace: `trc-${(0x10000000 + ((i * 2654435761) >>> 0)).toString(16)}`,
    cache_action: pick(['hit', 'miss', 'refresh', 'evict', 'bypass'], i),
    key: `key-${(i * 7919) % 10007}`,
    tenant: `tenant-${(i * 17) % 250}`,
    query_type: pick(['select', 'insert', 'update', 'delete', 'upsert'], i),
    table: pick(['users', 'orders', 'sessions', 'invoices', 'catalog', 'outbox'], i * 5),
    rows: String((i * 13) % 5000),
    event: pick(['OrderCreated', 'PaymentCaptured', 'UserUpdated', 'InventoryReserved', 'EmailQueued'], i),
    partition: String((i * 19) % 64),
    lag: String((i * 23) % 10000),
    retry: String(1 + (i % 5)),
    upstream: pick(['stripe', 's3', 'redis', 'postgres', 'kafka', 'oauth'], i * 11),
    reason: pick(['timeout', 'connection reset', 'throttled', 'bad gateway', 'deadline exceeded'], i),
    account: `acct-${(i * 1543) % 20000}`,
    feature: pick(['checkout', 'profile', 'recommendations', 'notifications', 'search'], i),
    job: pick(['email-digest', 'invoice-sync', 'index-compact', 'session-cleanup', 'webhook-dispatch'], i),
    worker: `worker-${(i * 29) % 128}`,
    client: `client-${(i * 31) % 4096}`,
    limit_result: pick(['allow', 'allow', 'allow', 'deny', 'shadow-deny'], i),
    quota: String(100 + ((i * 41) % 10000)),
    region: pick(['us-east-1', 'us-west-2', 'eu-west-1', 'ap-south-1'], i),
    action: pick(['login', 'logout', 'token-refresh', 'role-change', 'api-key-rotate'], i),
    resource: pick(['account', 'role', 'session', 'api-key', 'invoice'], i),
    service
  };

  const rendered = template.replace(/\{([a-z_]+)\}/g, (_, key) => values[key] ?? 'unknown');
  // Add terms with known selectivity: "heartbeat" is common, "needle" is rare.
  const common = i % 3 === 0 ? ' heartbeat' : '';
  const rare = i % 997 === 0 ? ` needle-${i % 10}` : '';
  const sev = severity === 'error' ? ' escalation' : severity === 'warn' ? ' warning' : '';
  return `${rendered}${common}${rare}${sev}`;
}

async function tableExists(db) {
  const result = await db.query("select to_regclass('public.logs') as name");
  return Boolean(result.rows?.[0]?.name);
}

async function existingCount(db) {
  if (!(await tableExists(db))) return 0;
  const result = await db.query('select count(*)::int as count from logs');
  return Number(result.rows[0].count || 0);
}

async function createSchema(db) {
  await db.exec(`
    create table if not exists logs (
      id integer primary key,
      ts timestamp not null,
      severity text not null check (severity in ('debug','info','warn','error')),
      severity_rank integer not null,
      service text not null,
      message text not null,
      message_lc text not null
    );
  `);
}

async function createIndexes(db) {
  await db.exec(`
    create index if not exists logs_ts_desc_idx on logs (ts desc, id desc);
    create index if not exists logs_severity_ts_desc_idx on logs (severity, ts desc, id desc);
    create index if not exists logs_message_lc_idx on logs (message_lc);
    create index if not exists logs_service_idx on logs (service);
  `);
}

async function seed(db) {
  const started = Date.now();
  console.log(`[db] seeding ${ROW_COUNT.toLocaleString()} deterministic log rows...`);
  await db.exec('begin');
  try {
    const base = Date.parse('2024-01-01T00:00:00.000Z');
    const spanMs = 30 * 24 * 60 * 60 * 1000;
    const stepMs = Math.floor(spanMs / ROW_COUNT);

    for (let start = 1; start <= ROW_COUNT; start += BATCH_SIZE) {
      const end = Math.min(ROW_COUNT, start + BATCH_SIZE - 1);
      const placeholders = [];
      const params = [];
      let p = 1;
      for (let id = start; id <= end; id++) {
        const idx = id - 1;
        const severity = severityFor(idx);
        const service = pick(services, idx * 13);
        const ts = new Date(base + idx * stepMs).toISOString();
        const message = buildMessage(idx, severity, service);
        placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
        params.push(id, ts, severity, severityRank(severity), service, message, message.toLowerCase());
      }
      await db.query(
        `insert into logs (id, ts, severity, severity_rank, service, message, message_lc) values ${placeholders.join(',')}`,
        params
      );
      if (end % 10_000 === 0) console.log(`[db] seeded ${end.toLocaleString()} rows`);
    }
    await db.exec('commit');
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
  await createIndexes(db);
  console.log(`[db] seed complete in ${Date.now() - started}ms`);
}

async function initDb() {
  await mkdir(DB_DIR, { recursive: true });
  const db = new PGlite(DB_DIR);
  await createSchema(db);
  const count = await existingCount(db);
  if (count === ROW_COUNT) {
    console.log(`[db] found ${ROW_COUNT.toLocaleString()} rows, skipping seed`);
    await createIndexes(db);
  } else {
    if (count > 0) {
      console.warn(`[db] found partial corpus (${count}); rebuilding`);
      await db.exec('drop table if exists logs');
      await createSchema(db);
    }
    await seed(db);
  }
  return db;
}

function parseLogsQuery(req) {
  const rawOffset = req.query.offset ?? '0';
  const rawLimit = req.query.limit ?? '100';
  if (!/^\d+$/.test(String(rawOffset))) throw Object.assign(new Error('offset must be a non-negative integer'), { status: 400 });
  if (!/^\d+$/.test(String(rawLimit))) throw Object.assign(new Error('limit must be an integer between 1 and 200'), { status: 400 });
  const offset = Number(rawOffset);
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(offset) || offset < 0) throw Object.assign(new Error('offset must be a non-negative integer'), { status: 400 });
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw Object.assign(new Error('limit must be between 1 and 200'), { status: 400 });

  const severity = req.query.severity === undefined || req.query.severity === '' ? null : String(req.query.severity).toLowerCase();
  if (severity && !VALID_SEVERITIES.has(severity)) throw Object.assign(new Error('unknown severity'), { status: 400 });

  const q = req.query.q === undefined ? '' : String(req.query.q).trim().toLowerCase();
  if (q.length > 200) throw Object.assign(new Error('q must be at most 200 characters'), { status: 400 });
  return { offset, limit, severity, q };
}

function whereClause({ severity, q }, params) {
  const clauses = [];
  if (severity) {
    params.push(severityRank(severity));
    clauses.push(`severity_rank = $${params.length}`);
  }
  if (q) {
    params.push(`%${q.replace(/[\\%_]/g, char => `\\${char}`)}%`);
    clauses.push(`message_lc like $${params.length} escape '\\'`);
  }
  return clauses.length ? `where ${clauses.join(' and ')}` : '';
}

const db = await initDb();
const statsRows = await db.query('select severity, count(*)::int as count from logs group by severity');
const severityCounts = { debug: 0, info: 0, warn: 0, error: 0 };
for (const row of statsRows.rows) severityCounts[row.severity] = Number(row.count);
const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/stats', async (_req, res) => {
  res.json({ total: ROW_COUNT, severities: severityCounts });
});

app.get('/api/logs', async (req, res, next) => {
  try {
    const parsed = parseLogsQuery(req);
    const params = [];
    const where = whereClause(parsed, params);

    let countSql = `select count(*)::int as total from logs ${where}`;
    let countParams = [...params];
    let knownTotal = null;
    if (!parsed.q && parsed.severity) {
      knownTotal = severityCounts[parsed.severity];
    } else if (!parsed.q) {
      knownTotal = ROW_COUNT;
    }

    params.push(parsed.limit, parsed.offset);
    const limitIdx = params.length - 1;
    const offsetIdx = params.length;
    const rowsSql = `
      select id, ts, severity, service, message
      from logs
      ${where}
      order by ts desc, id desc
      limit $${limitIdx} offset $${offsetIdx}
    `;

    const [countResult, rowsResult] = await Promise.all([
      knownTotal === null ? db.query(countSql, countParams) : Promise.resolve({ rows: [{ total: knownTotal }] }),
      db.query(rowsSql, params)
    ]);

    res.set('Cache-Control', 'no-store');
    res.json({
      total: Number(countResult.rows[0].total),
      rows: rowsResult.rows
    });
  } catch (error) {
    next(error);
  }
});

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'internal server error' });
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
