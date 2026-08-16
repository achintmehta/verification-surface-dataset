import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'pgdata');

const TOTAL_ROWS = 100000;
const SERVICES = [
  'auth-service',
  'payment-gateway',
  'user-api',
  'search-indexer',
  'notification-worker',
  'billing-cron',
  'session-store',
  'edge-proxy',
];

// Severity distribution roughly 60/25/10/5 for info/debug? Spec says
// "distributed roughly 60/25/10/5" across debug/info/warn/error.
// We interpret the four severities in that order of prevalence.
const SEVERITIES = ['info', 'debug', 'warn', 'error'];

// Message templates with variable fragments so that some substrings are
// highly selective (rare tokens) and some are non-selective (common tokens).
const TEMPLATES = [
  'request completed for endpoint {endpoint} in {ms}ms',
  'request failed for endpoint {endpoint} with status {code}',
  'user {user} authenticated via {method}',
  'cache {result} for key {key}',
  'processed batch {batch} containing {n} items',
  'connection to {peer} {conn_state}',
  'retrying operation {op} attempt {attempt}',
  'validation error on field {field}: {reason}',
  'scheduled job {job} finished in {ms}ms',
  'rate limit {rl_state} for client {client}',
];

const ENDPOINTS = ['/v1/orders', '/v1/users', '/v1/search', '/v1/health', '/v1/webhooks'];
const METHODS = ['password', 'oauth', 'sso', 'apikey'];
const RESULTS = ['hit', 'miss'];
const CONN_STATES = ['established', 'dropped', 'timed out'];
const OPS = ['flush', 'sync', 'reindex', 'compact'];
const FIELDS = ['email', 'amount', 'currency', 'token'];
const REASONS = ['too long', 'malformed', 'missing', 'out of range'];
const RL_STATES = ['exceeded', 'ok'];

// A deterministic PRNG (mulberry32) so the seed is reproducible.
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
  return arr[Math.floor(rng() * arr.length)];
}

function severityFor(rng) {
  const r = rng();
  if (r < 0.6) return 'info';
  if (r < 0.85) return 'debug';
  if (r < 0.95) return 'warn';
  return 'error';
}

function buildMessage(rng) {
  const tpl = pick(rng, TEMPLATES);
  return tpl
    .replace('{endpoint}', pick(rng, ENDPOINTS))
    .replace('{ms}', String(1 + Math.floor(rng() * 2000)))
    .replace('{code}', pick(rng, ['400', '401', '403', '404', '500', '502', '503']))
    .replace('{user}', 'u' + Math.floor(rng() * 5000))
    .replace('{method}', pick(rng, METHODS))
    .replace('{result}', pick(rng, RESULTS))
    .replace('{key}', 'k:' + Math.floor(rng() * 100000).toString(16))
    .replace('{batch}', 'b' + Math.floor(rng() * 10000))
    .replace('{n}', String(1 + Math.floor(rng() * 500)))
    .replace('{peer}', pick(rng, SERVICES))
    .replace('{conn_state}', pick(rng, CONN_STATES))
    .replace('{op}', pick(rng, OPS))
    .replace('{attempt}', String(1 + Math.floor(rng() * 5)))
    .replace('{field}', pick(rng, FIELDS))
    .replace('{reason}', pick(rng, REASONS))
    .replace('{job}', 'job-' + Math.floor(rng() * 200))
    .replace('{ms}', String(1 + Math.floor(rng() * 2000)))
    .replace('{rl_state}', pick(rng, RL_STATES))
    .replace('{client}', 'c' + Math.floor(rng() * 3000));
}

let db;

export async function getDb() {
  if (db) return db;
  db = new PGlite(DATA_DIR);
  await db.waitReady;
  await init(db);
  return db;
}

async function init(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id         BIGINT PRIMARY KEY,
      ts         TIMESTAMPTZ NOT NULL,
      severity   TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service    TEXT NOT NULL,
      message    TEXT NOT NULL,
      message_lc TEXT NOT NULL
    );
  `);

  // Detect schema drift (missing message_lc from an older seed) and force a
  // clean reseed so the corpus matches the current schema/indexes.
  const colRes = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'logs' AND column_name = 'message_lc';`
  );
  const hasLc = colRes.rows.length > 0;
  if (!hasLc) {
    await db.exec('DROP TABLE IF EXISTS logs;');
    await db.exec(`
      CREATE TABLE logs (
        id         BIGINT PRIMARY KEY,
        ts         TIMESTAMPTZ NOT NULL,
        severity   TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
        service    TEXT NOT NULL,
        message    TEXT NOT NULL,
        message_lc TEXT NOT NULL
      );
    `);
  }

  const res = await db.query('SELECT COUNT(*)::int AS c FROM logs;');
  const count = res.rows[0].c;

  if (count >= TOTAL_ROWS) {
    // Already seeded; ensure indexes exist and return.
    await ensureIndexes(db);
    return;
  }

  if (count > 0) {
    // Partial / inconsistent seed — reset for a clean deterministic corpus.
    await db.exec('DROP INDEX IF EXISTS idx_logs_ts;');
    await db.exec('DROP INDEX IF EXISTS idx_logs_sev_ts;');
    await db.exec('DROP INDEX IF EXISTS idx_logs_msg_trgm;');
    await db.exec('TRUNCATE logs;');
  }

  await seed(db);
  await ensureIndexes(db);
}

async function ensureIndexes(db) {
  // Ordering index (ts DESC, id DESC) supports the base windowed scan.
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC, id DESC);'
  );
  // Severity equality + ordering.
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_logs_sev_ts ON logs (severity, ts DESC, id DESC);'
  );
  // Case-insensitive substring search. pg_trgm gives index-backed ILIKE.
  try {
    await db.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
    await db.exec(
      'CREATE INDEX IF NOT EXISTS idx_logs_msg_trgm ON logs USING gin (message_lc gin_trgm_ops);'
    );
  } catch (e) {
    // pg_trgm may be unavailable; ILIKE still works, just without the trgm index.
    // eslint-disable-next-line no-console
    console.warn('pg_trgm unavailable, falling back to plain ILIKE:', e.message);
  }
  await db.exec('ANALYZE logs;');
}

async function seed(db) {
  const rng = mulberry32(0x1234abcd);

  // Span 30 days ending "now" (fixed base for determinism-ish; timestamps
  // are deterministic given the fixed base below).
  const endMs = Date.UTC(2024, 0, 31, 0, 0, 0); // fixed deterministic end
  const spanMs = 30 * 24 * 60 * 60 * 1000;
  const startMs = endMs - spanMs;

  const BATCH = 2000;
  const cols = 5;

  for (let start = 0; start < TOTAL_ROWS; start += BATCH) {
    const end = Math.min(start + BATCH, TOTAL_ROWS);
    const values = [];
    const params = [];
    let p = 1;
    for (let i = start; i < end; i++) {
      const ts = new Date(startMs + Math.floor((i / TOTAL_ROWS) * spanMs) +
        Math.floor(rng() * 200)); // mostly monotonic with small jitter
      const severity = severityFor(rng);
      const service = pick(rng, SERVICES);
      const message = buildMessage(rng);
      values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(i, ts.toISOString(), severity, service, message, message.toLowerCase());
    }
    await db.query(
      `INSERT INTO logs (id, ts, severity, service, message, message_lc) VALUES ${values.join(',')};`,
      params
    );
  }
}

export const config = { TOTAL_ROWS, SERVICES, SEVERITIES };
