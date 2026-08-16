import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist PGLite to the local file system so a restart does not reseed.
const DATA_DIR = process.env.PGLITE_DIR
  ? path.resolve(process.env.PGLITE_DIR)
  : path.resolve(__dirname, '..', 'pgdata');

export const SEVERITIES = ['debug', 'info', 'warn', 'error'];
export const TOTAL_ROWS = 100_000;

// ---- Deterministic pseudo-random generator (mulberry32) ---------------------
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

const SERVICES = [
  'api-gateway',
  'auth-service',
  'billing',
  'checkout',
  'inventory',
  'notifications',
  'search-indexer',
  'worker-pool',
];

// Templates contain {token} placeholders replaced by variable fragments so that
// substring search has both selective (rare) and non-selective (common) terms.
const TEMPLATES = {
  debug: [
    'cache lookup for key {hash} hit={bool}',
    'trace span {hash} completed in {ms}ms',
    'evaluating feature flag {flag} for user {uid}',
    'connection pool stats active={n} idle={n}',
  ],
  info: [
    'request {method} {route} completed with status {status} in {ms}ms',
    'user {uid} performed action {action}',
    'processed batch {hash} of {n} items',
    'scheduled job {flag} finished successfully',
  ],
  warn: [
    'slow query detected on {route} took {ms}ms',
    'retrying request {hash} attempt {n}',
    'deprecated endpoint {route} called by client {uid}',
    'memory usage high at {n} percent',
  ],
  error: [
    'unhandled exception in {route}: {errcode}',
    'failed to connect to upstream {action} after {n} retries',
    'payment declined for user {uid} reason {errcode}',
    'timeout waiting for {flag} exceeded {ms}ms',
  ],
};

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
const ROUTES = [
  '/v1/orders',
  '/v1/users',
  '/v1/products',
  '/v1/cart',
  '/v1/payments',
  '/health',
];
const ACTIONS = ['login', 'logout', 'purchase', 'refund', 'update-profile', 'sync'];
const FLAGS = ['new-checkout', 'dark-mode', 'beta-search', 'fast-path'];
const ERRCODES = ['ECONNRESET', 'ETIMEDOUT', 'E_VALIDATION', 'E_UPSTREAM', 'E_DENIED'];
const STATUSES = [200, 201, 204, 301, 400, 404, 500, 503];

function pick(arr, r) {
  return arr[Math.floor(r * arr.length)];
}

// Severity distribution ~ 60/25/10/5 (debug/info/warn/error).
function pickSeverity(r) {
  if (r < 0.6) return 'debug';
  if (r < 0.85) return 'info';
  if (r < 0.95) return 'warn';
  return 'error';
}

function buildMessage(severity, rnd) {
  const templates = TEMPLATES[severity];
  const tpl = templates[Math.floor(rnd() * templates.length)];
  return tpl.replace(/\{(\w+)\}/g, (_, token) => {
    switch (token) {
      case 'hash':
        return Math.floor(rnd() * 0xffffff).toString(16).padStart(6, '0');
      case 'ms':
        return String(1 + Math.floor(rnd() * 4000));
      case 'n':
        return String(1 + Math.floor(rnd() * 100));
      case 'uid':
        return String(1000 + Math.floor(rnd() * 90000));
      case 'bool':
        return rnd() < 0.5 ? 'true' : 'false';
      case 'flag':
        return pick(FLAGS, rnd());
      case 'method':
        return pick(METHODS, rnd());
      case 'route':
        return pick(ROUTES, rnd());
      case 'status':
        return String(pick(STATUSES, rnd()));
      case 'action':
        return pick(ACTIONS, rnd());
      case 'errcode':
        return pick(ERRCODES, rnd());
      default:
        return token;
    }
  });
}

let dbInstance = null;

export async function getDb() {
  if (dbInstance) return dbInstance;
  dbInstance = new PGlite(DATA_DIR);
  await dbInstance.waitReady;
  return dbInstance;
}

async function tableIsSeeded(db) {
  const exists = await db.query(
    `SELECT EXISTS (
       SELECT FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'logs'
     ) AS present`
  );
  if (!exists.rows[0].present) return false;
  const count = await db.query('SELECT COUNT(*)::int AS c FROM logs');
  return count.rows[0].c >= TOTAL_ROWS;
}

async function createSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id       BIGINT PRIMARY KEY,
      ts       TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL,
      service  TEXT NOT NULL,
      message  TEXT NOT NULL
    );
  `);
}

async function createIndexes(db) {
  // Ordering by ts (descending scrolling), severity+ts for severity filter,
  // trigram index for case-insensitive substring search.
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_sev_ts ON logs (severity, ts DESC, id DESC);
  `);
  try {
    await db.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_msg_trgm
        ON logs USING gin (lower(message) gin_trgm_ops);
    `);
  } catch (err) {
    // pg_trgm may not be available in every PGLite build; substring search
    // still works via the lower(message) LIKE plan, just less optimally.
    console.warn('pg_trgm unavailable, substring search will use scan:', err.message);
  }
  await db.exec('ANALYZE logs;');
}

export async function seedIfNeeded() {
  const db = await getDb();

  if (await tableIsSeeded(db)) {
    // Ensure schema/indexes exist (they will if seeded), then done.
    console.log('logs table already seeded, skipping seed.');
    return { seeded: false };
  }

  console.log('Seeding logs corpus...');
  const started = Date.now();

  await createSchema(db);
  // Truncate any partial data from a prior aborted seed.
  await db.exec('TRUNCATE logs;');

  const rnd = mulberry32(0xC0FFEE);

  // 30 days of history ending "now" but deterministic relative to a fixed base.
  const baseEnd = Date.UTC(2024, 0, 31, 0, 0, 0); // 2024-01-31T00:00:00Z
  const spanMs = 30 * 24 * 60 * 60 * 1000;

  const BATCH = 2000;
  await db.exec('BEGIN;');
  try {
    for (let start = 0; start < TOTAL_ROWS; start += BATCH) {
      const end = Math.min(start + BATCH, TOTAL_ROWS);
      const values = [];
      const params = [];
      let p = 0;
      for (let i = start; i < end; i++) {
        const severity = pickSeverity(rnd());
        const service = pick(SERVICES, rnd());
        const message = buildMessage(severity, rnd);
        // Spread timestamps monotonically-ish across the span with jitter.
        const frac = i / TOTAL_ROWS;
        const jitter = (rnd() - 0.5) * (spanMs / TOTAL_ROWS) * 4;
        const tsMs = Math.round(baseEnd - spanMs + frac * spanMs + jitter);
        const ts = new Date(tsMs).toISOString();
        values.push(`($${++p}, $${++p}, $${++p}, $${++p}, $${++p})`);
        params.push(i, ts, severity, service, message);
      }
      await db.query(
        `INSERT INTO logs (id, ts, severity, service, message) VALUES ${values.join(',')}`,
        params
      );
    }
    await db.exec('COMMIT;');
  } catch (err) {
    await db.exec('ROLLBACK;');
    throw err;
  }

  await createIndexes(db);

  const elapsed = Date.now() - started;
  console.log(`Seeded ${TOTAL_ROWS} rows in ${elapsed}ms`);
  return { seeded: true, elapsedMs: elapsed };
}
