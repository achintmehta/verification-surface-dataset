import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const PORT = Number(process.env.PORT || 3000);
const ROW_COUNT = 100_000;
const MAX_LIMIT = 200;
const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const services = ['api-gateway', 'auth', 'billing', 'catalog', 'checkout', 'inventory', 'notifications', 'worker'];
const messageTemplates = [
  'request completed route={route} status={status} latency={latency}ms trace={trace}',
  'cache {cacheResult} key={key} shard={shard} latency={latency}ms',
  'database query {queryType} rows={rows} duration={latency}ms connection={conn}',
  'job {jobName} {jobState} attempt={attempt} queue={queue}',
  'user session {sessionEvent} user={user} region={region}',
  'payment {paymentState} provider={provider} amount={amount} currency=USD',
  'feature flag {flag} evaluated variant={variant} account={account}',
  'rate limit {limitState} ip={ip} bucket={bucket}',
  'external call {dependency} result={depResult} latency={latency}ms',
  'validation {validationState} field={field} request={requestId}',
  'timeout while calling {dependency} after {latency}ms retry={attempt}',
  'disk pressure {pressureLevel} path=/var/lib/{service} usage={percent}%'
];
const routes = ['/v1/search', '/v1/orders', '/v1/login', '/v1/cart', '/v1/items', '/health', '/v1/users', '/v1/payments'];
const regions = ['us-east', 'us-west', 'eu-central', 'ap-south'];
const dependencies = ['redis', 'postgres', 'stripe', 'sendgrid', 's3', 'kafka'];

const db = new PGlite('./pglite-data');

function severityFor(i) {
  const n = i % 100;
  if (n < 60) return 'debug';
  if (n < 85) return 'info';
  if (n < 95) return 'warn';
  return 'error';
}

function fragment(template, rowNumber, severity, service) {
  const latency = 5 + ((rowNumber * 17) % (severity === 'error' ? 5000 : severity === 'warn' ? 1200 : 250));
  const status = severity === 'error' ? [500, 502, 503, 504][rowNumber % 4] : severity === 'warn' ? [202, 400, 409, 429][rowNumber % 4] : [200, 200, 201, 204][rowNumber % 4];
  const values = {
    route: routes[rowNumber % routes.length],
    status,
    latency,
    trace: `tr-${(rowNumber * 2654435761 >>> 0).toString(16).padStart(8, '0')}`,
    cacheResult: ['hit', 'miss', 'stale', 'refresh'][rowNumber % 4],
    key: `tenant-${rowNumber % 137}:object-${rowNumber % 997}`,
    shard: rowNumber % 32,
    queryType: ['select', 'insert', 'update', 'delete'][rowNumber % 4],
    rows: (rowNumber * 13) % 1000,
    conn: `pool-${rowNumber % 16}`,
    jobName: ['reconcile', 'email-digest', 'index-products', 'expire-sessions'][rowNumber % 4],
    jobState: severity === 'error' ? 'failed' : ['started', 'completed', 'deferred', 'completed'][rowNumber % 4],
    attempt: 1 + (rowNumber % 5),
    queue: ['critical', 'default', 'bulk'][rowNumber % 3],
    sessionEvent: ['created', 'refreshed', 'revoked', 'expired'][rowNumber % 4],
    user: `user-${(rowNumber * 31) % 20000}`,
    region: regions[rowNumber % regions.length],
    paymentState: severity === 'error' ? 'declined' : ['authorized', 'captured', 'refunded', 'pending'][rowNumber % 4],
    provider: ['stripe', 'adyen', 'paypal'][rowNumber % 3],
    amount: ((rowNumber * 19) % 50000 / 100).toFixed(2),
    flag: ['new-checkout', 'fast-login', 'recommendations', 'fraud-rules'][rowNumber % 4],
    variant: ['control', 'a', 'b'][rowNumber % 3],
    account: `acct-${rowNumber % 5000}`,
    limitState: severity === 'warn' || severity === 'error' ? 'exceeded' : 'allowed',
    ip: `10.${rowNumber % 255}.${(rowNumber * 7) % 255}.${(rowNumber * 11) % 255}`,
    bucket: `b${rowNumber % 64}`,
    dependency: dependencies[rowNumber % dependencies.length],
    depResult: severity === 'error' ? 'failure' : ['success', 'success', 'throttled', 'success'][rowNumber % 4],
    validationState: severity === 'error' ? 'failed' : ['passed', 'passed', 'warning', 'passed'][rowNumber % 4],
    field: ['email', 'postal_code', 'sku', 'quantity'][rowNumber % 4],
    requestId: `req-${rowNumber.toString(36)}`,
    pressureLevel: severity === 'error' ? 'critical' : severity === 'warn' ? 'high' : 'normal',
    service,
    percent: 20 + (rowNumber % 80)
  };
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
}

function makeRow(rowNumber) {
  const severity = severityFor(rowNumber);
  const service = services[rowNumber % services.length];
  const base = Date.UTC(2024, 0, 1, 0, 0, 0);
  const spanMs = 30 * 24 * 60 * 60 * 1000;
  const ts = new Date(base + Math.floor((rowNumber - 1) * spanMs / ROW_COUNT)).toISOString();
  const template = messageTemplates[(rowNumber * 7 + Math.floor(rowNumber / 97)) % messageTemplates.length];
  const message = fragment(template, rowNumber, severity, service);
  return [ts, severity, service, message, message.toLowerCase()];
}

async function initialize() {
  console.time('database ready');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL,
      message_lc TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_logs_ts_desc ON logs (ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts_desc ON logs (severity, ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_message_lc ON logs (message_lc);
  `);

  const existing = await db.query('SELECT COUNT(*)::int AS count FROM logs');
  const count = Number(existing.rows[0]?.count || 0);
  if (count === ROW_COUNT) {
    console.log(`Seed skipped: ${count} rows already present.`);
    console.timeEnd('database ready');
    return;
  }

  console.log(`Seeding deterministic corpus (${ROW_COUNT} rows)...`);
  await db.exec('BEGIN');
  try {
    await db.exec('TRUNCATE logs');
    const batchSize = 1000;
    for (let start = 1; start <= ROW_COUNT; start += batchSize) {
      const params = [];
      const placeholders = [];
      const end = Math.min(ROW_COUNT, start + batchSize - 1);
      for (let n = start; n <= end; n++) {
        const [ts, severity, service, message, messageLc] = makeRow(n);
        const base = params.length;
        params.push(n, ts, severity, service, message, messageLc);
        placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
      }
      await db.query(
        `INSERT INTO logs (id, ts, severity, service, message, message_lc) VALUES ${placeholders.join(',')}`,
        params
      );
      if (start % 10000 === 1) console.log(`  inserted ${end.toLocaleString()} / ${ROW_COUNT.toLocaleString()}`);
    }
    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
  await db.exec('ANALYZE logs');
  console.log('Seed complete.');
  console.timeEnd('database ready');
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
  const severity = req.query.severity ? String(req.query.severity) : '';
  const q = req.query.q ? String(req.query.q).trim() : '';
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit) || offset < 0) {
    res.status(400).json({ error: 'invalid offset or limit' });
    return null;
  }
  if (limit < 1 || limit > MAX_LIMIT) {
    res.status(400).json({ error: `limit must be between 1 and ${MAX_LIMIT}` });
    return null;
  }
  if (severity && !VALID_SEVERITIES.has(severity)) {
    res.status(400).json({ error: 'unknown severity' });
    return null;
  }
  if (q.length > 200) {
    res.status(400).json({ error: 'q is too long' });
    return null;
  }
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
    params.push(`%${q.toLowerCase()}%`);
    clauses.push(`message_lc LIKE $${params.length}`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/logs', async (req, res, next) => {
  try {
    const parsed = parseLogsParams(req, res);
    if (!parsed) return;
    const { offset, limit } = parsed;
    const { where, params } = buildWhere(parsed);
    const countSql = `SELECT COUNT(*)::int AS total FROM logs ${where}`;
    const rowsSql = `
      SELECT id, ts, severity, service, message
      FROM logs
      ${where}
      ORDER BY ts DESC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    const [countResult, rowsResult] = await Promise.all([
      db.query(countSql, params),
      db.query(rowsSql, [...params, limit, offset])
    ]);
    res.json({ total: Number(countResult.rows[0]?.total || 0), rows: rowsResult.rows });
  } catch (error) {
    next(error);
  }
});

app.get('/api/stats', async (_req, res, next) => {
  try {
    const result = await db.query(`
      SELECT severity, COUNT(*)::int AS count
      FROM logs
      GROUP BY severity
    `);
    const severities = { debug: 0, info: 0, warn: 0, error: 0 };
    let total = 0;
    for (const row of result.rows) {
      severities[row.severity] = Number(row.count);
      total += Number(row.count);
    }
    res.json({ total, severities });
  } catch (error) {
    next(error);
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'internal server error' });
});

initialize()
  .then(() => {
    app.listen(PORT, () => console.log(`Log explorer API listening on http://localhost:${PORT}`));
  })
  .catch((error) => {
    console.error('Failed to initialize database', error);
    process.exit(1);
  });
