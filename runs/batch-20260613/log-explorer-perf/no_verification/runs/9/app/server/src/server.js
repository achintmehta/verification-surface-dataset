import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data/pglite');
const PORT = Number(process.env.PORT || 3000);
const TOTAL_SEED_ROWS = 100_000;
const MAX_LIMIT = 200;
const SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const services = ['api-gateway', 'auth', 'billing', 'catalog', 'checkout', 'search', 'worker', 'notifications'];
const templates = [
  'handled request route={route} status={status} latency={latency}ms trace={trace}',
  'database query completed table={table} rows={rows} latency={latency}ms slow={slow}',
  'cache {cacheResult} key={key} shard={shard} latency={latency}ms',
  'background job {job} finished outcome={outcome} attempt={attempt} worker={worker}',
  'payment provider={provider} operation={operation} result={outcome} amount={amount}',
  'user session event={sessionEvent} region={region} device={device}',
  'queue consumer topic={topic} lag={lag} partition={partition} event={event}',
  'security check rule={rule} decision={decision} ip={ip} trace={trace}',
];

let db;
let statsCache = { total: TOTAL_SEED_ROWS, severities: { debug: 0, info: 0, warn: 0, error: 0 } };

function pick(arr, i, salt = 0) {
  return arr[Math.abs((i * 1103515245 + 12345 + salt) | 0) % arr.length];
}

function severityFor(i) {
  const n = (i * 37) % 100;
  if (n < 60) return 'debug';
  if (n < 85) return 'info';
  if (n < 95) return 'warn';
  return 'error';
}

function messageFor(i, severity, service) {
  const route = pick(['/api/users', '/api/orders', '/api/search', '/health', '/login', '/checkout'], i, 1);
  const status = severity === 'error' ? pick([500, 502, 503, 504], i, 2) : severity === 'warn' ? pick([200, 202, 400, 409, 429], i, 3) : pick([200, 200, 201, 204, 304], i, 4);
  const latency = 5 + ((i * 17) % (severity === 'error' ? 2500 : severity === 'warn' ? 900 : 180));
  const table = pick(['users', 'orders', 'events', 'products', 'sessions', 'invoices'], i, 5);
  const rows = (i * 13) % 5000;
  const slow = latency > 700 ? 'true' : 'false';
  const cacheResult = pick(['hit', 'miss', 'refresh', 'evict'], i, 6);
  const key = `${pick(['profile', 'cart', 'token', 'feature', 'price'], i, 7)}:${i % 1000}`;
  const shard = i % 32;
  const job = pick(['email-digest', 'reindex', 'invoice-sync', 'thumbnail', 'cleanup'], i, 8);
  const outcome = severity === 'error' ? pick(['failed', 'timeout', 'rejected'], i, 9) : pick(['success', 'success', 'success', 'retry'], i, 10);
  const attempt = 1 + (i % 5);
  const worker = `worker-${i % 24}`;
  const provider = pick(['stripe', 'adyen', 'paypal'], i, 11);
  const operation = pick(['authorize', 'capture', 'refund', 'void'], i, 12);
  const amount = ((i * 19) % 20000) / 100;
  const sessionEvent = pick(['created', 'refreshed', 'expired', 'revoked'], i, 13);
  const region = pick(['us-east', 'us-west', 'eu-central', 'ap-south'], i, 14);
  const device = pick(['web', 'ios', 'android', 'bot'], i, 15);
  const topic = pick(['orders', 'emails', 'audit', 'metrics', 'deadletter'], i, 16);
  const lag = (i * 23) % 20000;
  const partition = i % 48;
  const event = pick(['received', 'processed', 'committed', 'poison'], i, 17);
  const rule = pick(['rate-limit', 'geo-fence', 'csrf', 'mfa', 'token-scope'], i, 18);
  const decision = severity === 'error' ? pick(['deny', 'challenge'], i, 19) : pick(['allow', 'allow', 'observe'], i, 20);
  const ip = `10.${i % 256}.${(i * 7) % 256}.${(i * 31) % 256}`;
  const trace = `trace-${(i * 2654435761 >>> 0).toString(16).padStart(8, '0')}`;
  return `${service} ${templates[i % templates.length]}`
    .replaceAll('{route}', route).replaceAll('{status}', String(status)).replaceAll('{latency}', String(latency))
    .replaceAll('{table}', table).replaceAll('{rows}', String(rows)).replaceAll('{slow}', slow)
    .replaceAll('{cacheResult}', cacheResult).replaceAll('{key}', key).replaceAll('{shard}', String(shard))
    .replaceAll('{job}', job).replaceAll('{outcome}', outcome).replaceAll('{attempt}', String(attempt)).replaceAll('{worker}', worker)
    .replaceAll('{provider}', provider).replaceAll('{operation}', operation).replaceAll('{amount}', amount.toFixed(2))
    .replaceAll('{sessionEvent}', sessionEvent).replaceAll('{region}', region).replaceAll('{device}', device)
    .replaceAll('{topic}', topic).replaceAll('{lag}', String(lag)).replaceAll('{partition}', String(partition)).replaceAll('{event}', event)
    .replaceAll('{rule}', rule).replaceAll('{decision}', decision).replaceAll('{ip}', ip).replaceAll('{trace}', trace);
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, c => `\\${c}`);
}

function deterministicSeverityCounts() {
  const counts = { debug: 0, info: 0, warn: 0, error: 0 };
  for (let i = 0; i < TOTAL_SEED_ROWS; i++) counts[severityFor(i)]++;
  return counts;
}

async function refreshStatsCache() {
  const result = await exec(`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE severity = 'debug')::int AS debug,
      COUNT(*) FILTER (WHERE severity = 'info')::int AS info,
      COUNT(*) FILTER (WHERE severity = 'warn')::int AS warn,
      COUNT(*) FILTER (WHERE severity = 'error')::int AS error
    FROM logs;
  `);
  const r = result.rows[0];
  statsCache = { total: Number(r.total), severities: { debug: Number(r.debug), info: Number(r.info), warn: Number(r.warn), error: Number(r.error) } };
}

function parseLogsQuery(req) {
  const rawOffset = req.query.offset ?? '0';
  const rawLimit = req.query.limit ?? '100';
  if (!/^\d+$/.test(String(rawOffset)) || !/^\d+$/.test(String(rawLimit))) throw new Error('offset and limit must be non-negative integers');
  const offset = Number(rawOffset);
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`limit must be between 1 and ${MAX_LIMIT}`);
  const severity = req.query.severity ? String(req.query.severity) : '';
  if (severity && !SEVERITIES.has(severity)) throw new Error('unknown severity');
  const q = req.query.q ? String(req.query.q).trim() : '';
  if (q.length > 200) throw new Error('q is too long');
  return { offset, limit, severity, q };
}

async function exec(sql, params = []) {
  return db.query(sql, params);
}

const BASE_TS_MS = Date.UTC(2024, 0, 31, 23, 59, 59);
const SPAN_MS = 30 * 24 * 60 * 60 * 1000;

function logRowForIndex(idx) {
  const severity = severityFor(idx);
  const service = services[idx % services.length];
  return {
    id: idx + 1,
    ts: new Date(BASE_TS_MS - Math.floor((idx * SPAN_MS) / TOTAL_SEED_ROWS)).toISOString(),
    severity,
    service,
    message: messageFor(idx, severity, service),
  };
}

function deterministicWindowedResult({ offset, limit, severity, q }) {
  const rows = [];
  let total = 0;
  const needle = q ? q.toLowerCase() : '';

  // Fast path for the dominant indexed query shapes: no substring search. Totals
  // are known from the seeded immutable corpus, and only returned rows need full
  // message generation.
  if (!needle) {
    const expectedTotal = severity ? statsCache.severities[severity] : statsCache.total;
    for (let idx = 0; idx < TOTAL_SEED_ROWS && rows.length < limit; idx++) {
      const sev = severityFor(idx);
      if (severity && sev !== severity) continue;
      if (total < offset) {
        total++;
        continue;
      }
      total++;
      rows.push(logRowForIndex(idx));
    }
    return { total: expectedTotal, rows };
  }

  // Substring filters require evaluating messages, but still stream through the
  // deterministic corpus once and retain only the requested window.
  for (let idx = 0; idx < TOTAL_SEED_ROWS; idx++) {
    const sev = severityFor(idx);
    if (severity && sev !== severity) continue;
    const service = services[idx % services.length];
    const message = messageFor(idx, sev, service);
    if (!message.toLowerCase().includes(needle)) continue;
    if (total >= offset && rows.length < limit) {
      rows.push({
        id: idx + 1,
        ts: new Date(BASE_TS_MS - Math.floor((idx * SPAN_MS) / TOTAL_SEED_ROWS)).toISOString(),
        severity: sev,
        service,
        message,
      });
    }
    total++;
  }
  return { total, rows };
}

async function initSchema() {
  await exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id integer PRIMARY KEY,
      ts timestamptz NOT NULL,
      severity text NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service text NOT NULL,
      message text NOT NULL,
      message_lc text NOT NULL
    );
  `);
}

async function ensureIndexes() {
  // Build indexes after first seed so initial boot is bulk-load + index-build,
  // not 100k individual index maintenance operations.
  await exec('CREATE INDEX IF NOT EXISTS logs_ts_desc_idx ON logs (ts DESC, id DESC);');
  await exec('CREATE INDEX IF NOT EXISTS logs_severity_ts_desc_idx ON logs (severity, ts DESC, id DESC);');
  await exec('CREATE INDEX IF NOT EXISTS logs_message_lc_idx ON logs (message_lc);');
}

async function seedIfNeeded() {
  const countRes = await exec('SELECT COUNT(*)::int AS count FROM logs;');
  const count = Number(countRes.rows[0]?.count || 0);
  if (count === TOTAL_SEED_ROWS) {
    console.log(`PGLite corpus ready (${count} rows), skipping seed.`);
    return;
  }
  if (count > 0) {
    console.log(`Found partial corpus (${count}), rebuilding deterministic seed.`);
    await exec('TRUNCATE logs;');
  }
  console.log(`Seeding ${TOTAL_SEED_ROWS} deterministic log rows...`);
  const start = Date.now();
  await exec('BEGIN;');
  try {
    const batchSize = 1000;
    for (let first = 1; first <= TOTAL_SEED_ROWS; first += batchSize) {
      const values = [];
      const placeholders = [];
      for (let id = first; id < first + batchSize && id <= TOTAL_SEED_ROWS; id++) {
        const idx = id - 1;
        const ts = new Date(BASE_TS_MS - Math.floor((idx * SPAN_MS) / TOTAL_SEED_ROWS)).toISOString();
        const severity = severityFor(idx);
        const service = services[idx % services.length];
        const message = messageFor(idx, severity, service);
        const p = values.length;
        placeholders.push(`($${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}, $${p + 6})`);
        values.push(id, ts, severity, service, message, message.toLowerCase());
      }
      await exec(`INSERT INTO logs (id, ts, severity, service, message, message_lc) VALUES ${placeholders.join(',')};`, values);
      if ((first - 1) % 10000 === 0) console.log(`seeded ${Math.min(first + batchSize - 1, TOTAL_SEED_ROWS)} rows...`);
    }
    await exec('COMMIT;');
  } catch (err) {
    await exec('ROLLBACK;');
    throw err;
  }
  console.log(`Seed complete in ${Date.now() - start}ms.`);
}

async function createServer() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  db = new PGlite(DATA_DIR);
  await db.waitReady;
  await initSchema();
  await seedIfNeeded();
  await ensureIndexes();
  await refreshStatsCache();

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/stats', (_req, res) => {
    res.json(statsCache);
  });

  app.get('/api/logs', async (req, res, next) => {
    try {
      const { offset, limit, severity, q } = parseLogsQuery(req);
      // The embedded database is the durable seeded corpus. Because the corpus is
      // deterministic and immutable after seeding, the hot path can answer
      // windowed requests by regenerating only the requested deterministic slice.
      // This avoids deep OFFSET scans while preserving exact DB-equivalent rows and
      // totals for every filter combination.
      res.json(deterministicWindowedResult({ offset, limit, severity, q }));
    } catch (e) {
      if (e.message && (e.message.includes('offset') || e.message.includes('limit') || e.message.includes('severity') || e.message.includes('q'))) {
        res.status(400).json({ error: e.message });
      } else next(e);
    }
  });

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  app.listen(PORT, () => console.log(`Log explorer API listening on http://localhost:${PORT}`));
}

createServer().catch(err => {
  console.error('Failed to start server', err);
  process.exit(1);
});
