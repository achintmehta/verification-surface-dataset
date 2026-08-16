import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'pgdata');

export const SEVERITIES = ['debug', 'info', 'warn', 'error'];
export const TOTAL_ROWS = 100000;
const NUM_SERVICES = 8;
const DAYS_SPAN = 30;

const SERVICES = [
  'auth-service',
  'payment-gateway',
  'user-api',
  'search-indexer',
  'notification-worker',
  'billing-cron',
  'media-transcoder',
  'edge-proxy',
];

// Message templates with variable fragments. Some fragments are selective
// (rare) and some are non-selective (common), so substring search can be
// exercised at both ends.
const TEMPLATES = [
  'Request {method} {path} completed in {ms}ms status {code}',
  'Connection pool exhausted retry {n} for {resource}',
  'Cache {hitmiss} for key user:{uid}:profile',
  'Processed batch of {n} items in queue {queue}',
  'Timeout waiting for downstream {resource} after {ms}ms',
  'Authentication {result} for account {uid}',
  'Disk usage at {code}% on volume {resource}',
  'Retrying {method} {path} attempt {n}',
  'Payment {result} for order {uid} amount {ms}',
  'Slow query detected {ms}ms on table {queue}',
  'Rate limit {result} for client {uid}',
  'Background job {queue} finished with {n} warnings',
];

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
const PATHS = ['/v1/users', '/v1/orders', '/v1/search', '/v1/media', '/healthz', '/v1/billing'];
const RESOURCES = ['redis-primary', 'pg-replica', 's3-bucket', 'kafka-broker', 'elastic-node'];
const QUEUES = ['ingest', 'export', 'thumbnails', 'emails', 'reports'];
const HITMISS = ['hit', 'miss'];
const RESULTS = ['succeeded', 'failed', 'denied', 'granted'];

// A deterministic pseudo-random generator (mulberry32) so the corpus is
// identical on every seed.
function makeRng(seed) {
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
  return arr[Math.floor(rng() * arr.length)];
}

// Severity distribution roughly 60/25/10/5 (info/... wait spec: 60/25/10/5)
// Interpreted as debug/info/warn/error? Spec says severities distributed
// roughly 60/25/10/5. We map the largest bucket to "info" as the common case,
// but to satisfy the exact ordering of the SEVERITIES list we use:
//   info 60, debug 25, warn 10, error 5
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
    .replace('{method}', pick(rng, METHODS))
    .replace('{path}', pick(rng, PATHS))
    .replace('{resource}', pick(rng, RESOURCES))
    .replace('{queue}', pick(rng, QUEUES))
    .replace('{hitmiss}', pick(rng, HITMISS))
    .replace('{result}', pick(rng, RESULTS))
    .replace('{ms}', String(Math.floor(rng() * 5000)))
    .replace('{code}', String(200 + Math.floor(rng() * 300)))
    .replace('{uid}', String(1000 + Math.floor(rng() * 90000)))
    .replace('{n}', String(1 + Math.floor(rng() * 50)));
}

let dbInstance = null;

export async function getDb() {
  if (dbInstance) return dbInstance;
  dbInstance = new PGlite(DATA_DIR);
  await dbInstance.waitReady;
  return dbInstance;
}

async function isSeeded(db) {
  const check = await db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_name = 'logs'
    ) AS exists;
  `);
  if (!check.rows[0].exists) return false;
  const count = await db.query('SELECT COUNT(*)::int AS c FROM logs;');
  return count.rows[0].c >= TOTAL_ROWS;
}

async function createSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id      BIGINT PRIMARY KEY,
      ts      TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL,
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);
}

async function createIndexes(db) {
  // Ordering by ts (descending scans use this too).
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC, id DESC);');
  // Severity equality + ordering by ts.
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_sev_ts ON logs (severity, ts DESC, id DESC);');
  // Substring search: trigram-style acceleration via pg_trgm if available.
  // PGlite may not bundle pg_trgm; guard it.
  try {
    await db.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
    await db.exec(
      'CREATE INDEX IF NOT EXISTS idx_logs_msg_trgm ON logs USING gin (lower(message) gin_trgm_ops);'
    );
  } catch (e) {
    // Fallback: no trigram support; ILIKE will scan but the ts index still
    // bounds the work when combined with ordering.
    // eslint-disable-next-line no-console
    console.warn('pg_trgm not available, substring search will use sequential scan:', e.message);
  }
}

export async function seedIfNeeded() {
  const db = await getDb();
  await createSchema(db);

  if (await isSeeded(db)) {
    // Ensure indexes exist even on subsequent boots (cheap if already present).
    await createIndexes(db);
    return { seeded: false };
  }

  const rng = makeRng(0x1234abcd);

  // Timestamps span 30 days. We generate rows in chronological-ish order but
  // assign increasing ids. ts is spread evenly with jitter across the window.
  const now = Date.now();
  const spanMs = DAYS_SPAN * 24 * 60 * 60 * 1000;
  const start = now - spanMs;
  const stepMs = spanMs / TOTAL_ROWS;

  const BATCH = 2000;
  const t0 = Date.now();

  for (let batchStart = 0; batchStart < TOTAL_ROWS; batchStart += BATCH) {
    const end = Math.min(batchStart + BATCH, TOTAL_ROWS);
    const values = [];
    const params = [];
    let p = 1;
    for (let i = batchStart; i < end; i++) {
      // ts increases with i, plus jitter within the step for uniqueness spread.
      const jitter = Math.floor(rng() * stepMs);
      const tsMs = Math.floor(start + i * stepMs + jitter);
      const ts = new Date(tsMs).toISOString();
      const severity = pickSeverity(rng);
      const service = SERVICES[Math.floor(rng() * NUM_SERVICES)];
      const message = buildMessage(rng);
      values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(i, ts, severity, service, message);
    }
    await db.query(
      `INSERT INTO logs (id, ts, severity, service, message) VALUES ${values.join(',')};`,
      params
    );
  }

  await createIndexes(db);
  // ANALYZE so the planner picks the right indexes.
  try {
    await db.exec('ANALYZE logs;');
  } catch {
    /* ignore */
  }

  const elapsed = Date.now() - t0;
  return { seeded: true, elapsedMs: elapsed };
}
