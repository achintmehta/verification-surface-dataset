'use strict';

const path = require('path');

// Location on disk where PGLite persists its data. Keeping this stable across
// restarts is what allows us to detect an already-seeded corpus and skip the
// (expensive) seed on subsequent boots.
const DATA_DIR = path.join(__dirname, '..', '.pgdata');

const SEVERITIES = ['debug', 'info', 'warn', 'error'];

// Deterministic corpus configuration.
const TOTAL_ROWS = 100000;
const SERVICES = [
  'auth-service',
  'payment-gateway',
  'user-api',
  'inventory-worker',
  'notification-svc',
  'search-index',
  'billing-cron',
  'edge-proxy',
];

// 30 days of history, ending "now" at a fixed anchor so the corpus is fully
// deterministic and reproducible across boots.
const DAY_MS = 24 * 60 * 60 * 1000;
const CORPUS_SPAN_MS = 30 * DAY_MS;
// Fixed anchor timestamp (2024-01-31T00:00:00Z) so seeds are identical.
const ANCHOR_MS = Date.UTC(2024, 0, 31, 0, 0, 0);

// Message templates. Some fragments are highly selective (rare terms) and some
// are non-selective (appear in a large fraction of rows) so substring search
// exercises both the fast and slow paths.
const TEMPLATES = [
  'Request completed status={status} latency={ms}ms path={path}',
  'Request completed status={status} path={path}',
  'User {user} authenticated via {method}',
  'Cache {hitmiss} for key {key}',
  'Database query executed rows={rows} duration={ms}ms',
  'Connection pool checkout waited {ms}ms',
  'Retrying operation attempt={n} reason={reason}',
  'Payment {status} amount={amt} currency={cur}',
  'Background job {job} finished in {ms}ms',
  'Queue depth is {rows} for topic {path}',
  'Rate limit exceeded for client {user}',
  'Configuration reloaded from {path}',
  'Health check ok for {method}',
  'Timeout talking to upstream {path}',
  'Unhandled exception in {job}: {reason}',
];

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
const REASONS = ['timeout', 'conn_reset', 'invalid_state', 'deadlock', 'quota'];
const HITMISS = ['hit', 'miss'];
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY'];
const JOBS = ['reindex', 'cleanup', 'digest', 'sync', 'aggregate'];
const PATHS = [
  '/v1/orders',
  '/v1/users',
  '/v1/search',
  '/v1/checkout',
  '/health',
  '/metrics',
  '/v2/items',
];

// Simple deterministic PRNG (mulberry32) so the seed is identical every time.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

// Distribute severities roughly 60/25/10/5 (info/debug... actually per spec:
// severities distributed roughly 60/25/10/5). We map the largest share to the
// most common level. The spec lists debug/info/warn/error; we treat the
// distribution as info=60, debug=25, warn=10, error=5.
function pickSeverity(rng) {
  const r = rng();
  if (r < 0.6) return 'info';
  if (r < 0.85) return 'debug';
  if (r < 0.95) return 'warn';
  return 'error';
}

function buildMessage(rng) {
  const tpl = pick(rng, TEMPLATES);
  return tpl
    .replace('{status}', String(pick(rng, [200, 201, 204, 400, 401, 403, 404, 500, 502, 503])))
    .replace('{ms}', String(Math.floor(rng() * 5000)))
    .replace('{path}', pick(rng, PATHS))
    .replace('{user}', 'u' + Math.floor(rng() * 100000))
    .replace('{method}', pick(rng, METHODS))
    .replace('{hitmiss}', pick(rng, HITMISS))
    .replace('{key}', 'k' + Math.floor(rng() * 100000).toString(16))
    .replace('{rows}', String(Math.floor(rng() * 10000)))
    .replace('{n}', String(1 + Math.floor(rng() * 5)))
    .replace('{reason}', pick(rng, REASONS))
    .replace('{amt}', (rng() * 1000).toFixed(2))
    .replace('{cur}', pick(rng, CURRENCIES))
    .replace('{job}', pick(rng, JOBS));
}

let dbInstance = null;

async function getDb() {
  if (dbInstance) return dbInstance;
  // PGlite ships as ESM only; load it via dynamic import from CommonJS.
  const { PGlite } = await import('@electric-sql/pglite');
  dbInstance = new PGlite(DATA_DIR);
  await dbInstance.waitReady;
  return dbInstance;
}

async function init() {
  const db = await getDb();

  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id       BIGINT PRIMARY KEY,
      ts       TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service  TEXT NOT NULL,
      message  TEXT NOT NULL
    );
  `);

  // Detect an already-seeded corpus and skip the expensive seed.
  const countRes = await db.query('SELECT COUNT(*)::int AS c FROM logs;');
  const existing = countRes.rows[0].c;

  if (existing >= TOTAL_ROWS) {
    await ensureIndexes(db);
    return { seeded: false, count: existing };
  }

  // Fresh (or partial) table: wipe any partial data and seed from scratch.
  if (existing > 0) {
    await db.exec('DELETE FROM logs;');
  }

  await seed(db);
  await ensureIndexes(db);

  const after = await db.query('SELECT COUNT(*)::int AS c FROM logs;');
  return { seeded: true, count: after.rows[0].c };
}

async function ensureIndexes(db) {
  // Ordering by ts descending across the whole corpus, and severity-equality
  // followed by ts ordering, are the two primary query shapes. We build
  // covering-ish btree indexes to keep windowed reads index-backed.
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts        ON logs (ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_sev_ts    ON logs (severity, ts DESC, id DESC);
  `);
  // Trigram-style substring search is not available without an extension; we
  // rely on a lowercased expression index to make ILIKE-equivalent scans as
  // cheap as possible. A functional index on lower(message) supports prefix
  // acceleration and keeps the scan on a narrower column.
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_msg_lower ON logs (lower(message));
  `);
}

async function seed(db) {
  const rng = mulberry32(0x1234abcd);
  const BATCH = 2000;

  // Timestamps are spread evenly (with jitter) across the 30-day window. We
  // assign each row a ts and let the index handle ordering; ids are sequential.
  for (let start = 0; start < TOTAL_ROWS; start += BATCH) {
    const end = Math.min(start + BATCH, TOTAL_ROWS);
    const values = [];
    const params = [];
    let p = 1;
    for (let i = start; i < end; i++) {
      // Even spread across the span plus deterministic jitter.
      const base = ANCHOR_MS - CORPUS_SPAN_MS + (i / TOTAL_ROWS) * CORPUS_SPAN_MS;
      const jitter = (rng() - 0.5) * (CORPUS_SPAN_MS / TOTAL_ROWS) * 4;
      const tsMs = Math.floor(base + jitter);
      const ts = new Date(tsMs).toISOString();
      const severity = pickSeverity(rng);
      const service = pick(rng, SERVICES);
      const message = buildMessage(rng);

      values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(i + 1, ts, severity, service, message);
    }
    const sql =
      'INSERT INTO logs (id, ts, severity, service, message) VALUES ' +
      values.join(',') +
      ';';
    await db.query(sql, params);
  }
}

module.exports = {
  getDb,
  init,
  SEVERITIES,
  TOTAL_ROWS,
  DATA_DIR,
};
