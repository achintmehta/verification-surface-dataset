import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', 'pgdata');
const PORT = Number(process.env.PORT || 3001);
const ROW_COUNT = 100_000;
const MAX_LIMIT = 200;
const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);

const SERVICES = [
  'auth-api',
  'billing-worker',
  'checkout',
  'inventory',
  'notification',
  'search',
  'gateway',
  'scheduler',
];

const TEMPLATES = [
  'request completed route={route} status={status} latency={latency}ms trace={trace}',
  'cache {cacheResult} key={key} shard={shard} ttl={ttl}s trace={trace}',
  'database query {queryType} table={table} rows={rows} latency={latency}ms trace={trace}',
  'job {jobName} finished outcome={outcome} attempt={attempt} queue={queue} trace={trace}',
  'external call provider={provider} status={status} latency={latency}ms region={region} trace={trace}',
  'feature flag {flag} evaluated variant={variant} account={account} trace={trace}',
  'rate limit check subject={subject} decision={decision} bucket={bucket} trace={trace}',
  'payload validation {validation} field={field} schema={schema} trace={trace}',
  'retry scheduled operation={operation} attempt={attempt} backoff={backoff}ms trace={trace}',
  'connection pool {poolEvent} active={active} idle={idle} waiting={waiting} trace={trace}',
];

const LISTS = {
  route: ['/login', '/logout', '/cart', '/checkout', '/orders', '/search', '/profile', '/health'],
  status: [200, 201, 204, 301, 400, 401, 403, 404, 409, 429, 500, 502, 503],
  cacheResult: ['hit', 'miss', 'refresh', 'evict'],
  queryType: ['select', 'insert', 'update', 'delete', 'upsert'],
  table: ['users', 'orders', 'sessions', 'payments', 'products', 'events'],
  jobName: ['email-digest', 'invoice-sync', 'index-refresh', 'cart-expiry', 'fraud-scan'],
  outcome: ['success', 'success', 'success', 'skipped', 'failed'],
  provider: ['stripe', 'sendgrid', 'twilio', 's3', 'taxjar', 'github'],
  region: ['us-east-1', 'us-west-2', 'eu-central-1', 'ap-south-1'],
  flag: ['new-checkout', 'risk-score-v2', 'fast-search', 'dark-mode', 'batch-refund'],
  variant: ['control', 'a', 'b', 'disabled', 'enabled'],
  subject: ['ip', 'user', 'api-key', 'session', 'tenant'],
  decision: ['allow', 'allow', 'allow', 'throttle', 'block'],
  validation: ['passed', 'passed', 'failed', 'warning'],
  field: ['email', 'address', 'quantity', 'token', 'metadata', 'price'],
  schema: ['v1', 'v2', 'v3', 'legacy'],
  operation: ['charge-card', 'send-email', 'reserve-stock', 'publish-event', 'refresh-token'],
  poolEvent: ['checkout', 'release', 'resize', 'timeout'],
  queue: ['critical', 'default', 'bulk', 'webhook'],
};

function pick(list, i, salt = 0) {
  return list[(i * 17 + salt * 31) % list.length];
}

function severityFor(i) {
  // Exact 60/25/10/5 distribution over each 20-row block.
  const m = i % 20;
  if (m < 12) return 'debug';
  if (m < 17) return 'info';
  if (m < 19) return 'warn';
  return 'error';
}

function renderMessage(i, severity, service) {
  const template = TEMPLATES[i % TEMPLATES.length];
  const replacements = {
    route: pick(LISTS.route, i, 1),
    status: pick(LISTS.status, i, severity === 'error' ? 11 : 2),
    latency: String(5 + ((i * 37) % (severity === 'error' ? 4000 : 450))),
    trace: `tr-${(0x100000000 + ((i * 2654435761) >>> 0)).toString(16).slice(1)}`,
    cacheResult: pick(LISTS.cacheResult, i, 3),
    key: `tenant:${(i * 13) % 997}:object:${(i * 19) % 10007}`,
    shard: String((i * 7) % 32),
    ttl: String(30 + ((i * 11) % 3600)),
    queryType: pick(LISTS.queryType, i, 4),
    table: pick(LISTS.table, i, 5),
    rows: String((i * 23) % 1500),
    jobName: pick(LISTS.jobName, i, 6),
    outcome: severity === 'error' ? 'failed' : pick(LISTS.outcome, i, 7),
    attempt: String(1 + ((i * 5) % 5)),
    queue: pick(LISTS.queue, i, 8),
    provider: pick(LISTS.provider, i, 9),
    region: pick(LISTS.region, i, 10),
    flag: pick(LISTS.flag, i, 11),
    variant: pick(LISTS.variant, i, 12),
    account: `acct_${100000 + ((i * 29) % 900000)}`,
    subject: pick(LISTS.subject, i, 13),
    decision: severity === 'warn' || severity === 'error' ? pick(['throttle', 'block', 'allow'], i, 14) : 'allow',
    bucket: `b${(i * 41) % 128}`,
    validation: severity === 'error' ? 'failed' : pick(LISTS.validation, i, 15),
    field: pick(LISTS.field, i, 16),
    schema: pick(LISTS.schema, i, 17),
    operation: pick(LISTS.operation, i, 18),
    backoff: String(50 + ((i * 43) % 5000)),
    poolEvent: pick(LISTS.poolEvent, i, 19),
    active: String((i * 3) % 80),
    idle: String((i * 5) % 40),
    waiting: String((i * 7) % 25),
  };
  let msg = template.replace(/\{(\w+)\}/g, (_, k) => replacements[k] ?? '');
  // Add terms with different selectivity for performance/functional checks.
  if (i % 2 === 0) msg += ' common heartbeat';
  if (i % 97 === 0) msg += ' needle dispute-id=rare-needle';
  if (severity === 'error') msg += ' alert escalation required';
  return `${service} ${severity}: ${msg}`;
}

async function initDb() {
  await mkdir(DATA_DIR, { recursive: true });
  const db = new PGlite(DATA_DIR);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);

  const countResult = await db.query('SELECT COUNT(*)::int AS count FROM logs');
  const existingCount = Number(countResult.rows[0]?.count || 0);

  if (existingCount !== ROW_COUNT) {
    console.log(`Seeding deterministic log corpus (${existingCount} existing rows; target ${ROW_COUNT})...`);
    const started = Date.now();
    await db.exec('BEGIN');
    try {
      await db.exec('TRUNCATE TABLE logs');
      const batchSize = 5000;
      const base = Date.UTC(2026, 0, 1, 0, 0, 0);
      const spanMs = 30 * 24 * 60 * 60 * 1000;
      for (let start = 0; start < ROW_COUNT; start += batchSize) {
        const ids = [];
        const timestamps = [];
        const severities = [];
        const services = [];
        const messages = [];
        const end = Math.min(start + batchSize, ROW_COUNT);
        for (let i = start; i < end; i++) {
          const id = i + 1;
          const severity = severityFor(i);
          const service = SERVICES[i % SERVICES.length];
          ids.push(id);
          // id=1 is newest; id=100000 is oldest. Spread evenly across 30 days.
          timestamps.push(new Date(base - Math.floor((i * spanMs) / (ROW_COUNT - 1))).toISOString());
          severities.push(severity);
          services.push(service);
          messages.push(renderMessage(i, severity, service));
        }
        await db.query(
          `INSERT INTO logs (id, ts, severity, service, message)
           SELECT * FROM unnest($1::int[], $2::timestamptz[], $3::text[], $4::text[], $5::text[])`,
          [ids, timestamps, severities, services, messages],
        );
        if ((start / batchSize) % 4 === 0) console.log(`  inserted ${end}/${ROW_COUNT}`);
      }
      await db.exec('COMMIT');
      console.log(`Seed completed in ${Date.now() - started} ms`);
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }
  } else {
    console.log(`Existing ${ROW_COUNT}-row corpus found; skipping seed.`);
  }

  console.log('Ensuring indexes...');
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts_desc ON logs (ts DESC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts_desc ON logs (severity, ts DESC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_logs_lower_message ON logs (lower(message));
    ANALYZE logs;
  `);

  return db;
}

function parseLogsQuery(query) {
  const offsetRaw = query.offset ?? '0';
  const limitRaw = query.limit ?? '100';
  if (!/^\d+$/.test(String(offsetRaw))) throw Object.assign(new Error('offset must be a non-negative integer'), { status: 400 });
  if (!/^\d+$/.test(String(limitRaw))) throw Object.assign(new Error('limit must be a positive integer no greater than 200'), { status: 400 });
  const offset = Number(offsetRaw);
  const limit = Number(limitRaw);
  if (!Number.isSafeInteger(offset) || offset < 0) throw Object.assign(new Error('offset must be a non-negative integer'), { status: 400 });
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw Object.assign(new Error('limit must be between 1 and 200'), { status: 400 });

  const severity = query.severity ? String(query.severity).toLowerCase() : '';
  if (severity && !VALID_SEVERITIES.has(severity)) throw Object.assign(new Error('unknown severity'), { status: 400 });

  const q = query.q == null ? '' : String(query.q).trim();
  if (q.length > 200) throw Object.assign(new Error('q must be at most 200 characters'), { status: 400 });

  return { offset, limit, severity, q };
}

function buildWhere({ severity, q }) {
  const where = [];
  const values = [];
  if (severity) {
    values.push(severity);
    where.push(`severity = $${values.length}`);
  }
  if (q) {
    values.push(`%${q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`lower(message) LIKE $${values.length} ESCAPE '\\'`);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', values };
}

function createApp(db) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/logs', async (req, res, next) => {
    try {
      const parsed = parseLogsQuery(req.query);
      const { clause, values } = buildWhere(parsed);
      const countSql = `SELECT COUNT(*)::int AS total FROM logs ${clause}`;
      const rowsSql = `
        SELECT id, ts, severity, service, message
        FROM logs
        ${clause}
        ORDER BY ts DESC, id ASC
        OFFSET $${values.length + 1}
        LIMIT $${values.length + 2}`;
      const [countResult, rowsResult] = await Promise.all([
        db.query(countSql, values),
        db.query(rowsSql, [...values, parsed.offset, parsed.limit]),
      ]);
      res.json({
        total: Number(countResult.rows[0]?.total || 0),
        rows: rowsResult.rows,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/stats', async (_req, res, next) => {
    try {
      const result = await db.query(`
        SELECT severity, COUNT(*)::int AS count
        FROM logs
        GROUP BY severity
      `);
      const bySeverity = { debug: 0, info: 0, warn: 0, error: 0 };
      let total = 0;
      for (const row of result.rows) {
        bySeverity[row.severity] = Number(row.count);
        total += Number(row.count);
      }
      res.json({ total, severities: bySeverity });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || 'internal server error' });
  });

  return app;
}

const db = await initDb();
const app = createApp(db);
app.listen(PORT, () => {
  console.log(`Log explorer API listening on http://localhost:${PORT}`);
});
