import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist the database on the local file system so the corpus survives restarts.
const DATA_DIR = process.env.PGLITE_DIR || path.join(__dirname, '..', 'data', 'pgdata');

export const SEVERITIES = ['debug', 'info', 'warn', 'error'];

const TARGET_ROWS = 100_000;
const SEED_BATCH_SIZE = 2_000;

// 30 day span, ending "now" at seed time but deterministic relative to a fixed epoch
// so the corpus is fully reproducible.
const EPOCH_MS = Date.UTC(2024, 0, 1, 0, 0, 0); // fixed base -> deterministic
const SPAN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const SERVICES = [
  'auth-service',
  'billing-service',
  'gateway',
  'search-indexer',
  'notification-worker',
  'payments-api',
  'user-profile',
  'analytics-pipeline',
];

// Severity distribution roughly 60/25/10/5 (info/debug/warn/error weighting the
// spec's "60/25/10/5"). We map cumulative buckets across a per-row deterministic value.
// info 60, debug 25, warn 10, error 5
function severityForBucket(bucket) {
  // bucket in [0,100)
  if (bucket < 60) return 'info';
  if (bucket < 85) return 'debug';
  if (bucket < 95) return 'warn';
  return 'error';
}

// Message templates with variable fragments. Some fragments appear frequently
// (non-selective substrings) and some rarely (selective substrings).
const TEMPLATES = [
  'request completed for {resource} in {ms}ms',
  'user {user} authenticated via {method}',
  'cache {hitmiss} for key {key}',
  'database query {resource} took {ms}ms',
  'payment {status} for order {order}',
  'notification dispatched to {user} channel {channel}',
  'search index rebuilt segment {seg} in {ms}ms',
  'connection {status} to upstream {resource}',
  'rate limit {hitmiss} for client {user}',
  'background job {status} batch {seg}',
];

const RESOURCES = ['orders', 'users', 'sessions', 'invoices', 'reports', 'tokens'];
const METHODS = ['password', 'oauth', 'saml', 'apikey'];
const CHANNELS = ['email', 'sms', 'push', 'webhook'];
const HITMISS = ['hit', 'miss'];
const STATUS = ['succeeded', 'failed', 'retrying', 'queued'];

// Deterministic PRNG (mulberry32) seeded per row from its id so the corpus is
// completely reproducible without storing any state.
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

function pick(arr, r) {
  return arr[Math.floor(r * arr.length) % arr.length];
}

function buildRow(id) {
  const rand = mulberry32(id * 2654435761);
  // Timestamp spread deterministically across the 30 day span. Using id keeps
  // it monotonic-ish but we add jitter so ts is not strictly ordered by id.
  const frac = (id * 7919) % TARGET_ROWS; // spread pseudo-uniformly
  const jitter = Math.floor(rand() * 60_000); // up to a minute of jitter
  const tsMs = EPOCH_MS + Math.floor((frac / TARGET_ROWS) * SPAN_MS) + jitter;
  const ts = new Date(tsMs).toISOString();

  const bucket = Math.floor(rand() * 100);
  const severity = severityForBucket(bucket);
  const service = pick(SERVICES, rand());

  const template = pick(TEMPLATES, rand());
  const message = template
    .replace('{resource}', pick(RESOURCES, rand()))
    .replace('{user}', `u${Math.floor(rand() * 5000)}`)
    .replace('{method}', pick(METHODS, rand()))
    .replace('{channel}', pick(CHANNELS, rand()))
    .replace('{hitmiss}', pick(HITMISS, rand()))
    .replace('{status}', pick(STATUS, rand()))
    .replace('{order}', `o${Math.floor(rand() * 100000)}`)
    .replace('{key}', `k${Math.floor(rand() * 2000)}`)
    .replace('{seg}', `${Math.floor(rand() * 256)}`)
    .replace('{ms}', `${1 + Math.floor(rand() * 1200)}`);

  return { id, ts, severity, service, message };
}

let dbInstance = null;

export async function getDb() {
  if (dbInstance) return dbInstance;
  const db = new PGlite(DATA_DIR);
  await db.waitReady;
  await initSchema(db);
  await seedIfNeeded(db);
  dbInstance = db;
  return db;
}

async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id       INTEGER PRIMARY KEY,
      ts       TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL,
      service  TEXT NOT NULL,
      message  TEXT NOT NULL
    );
  `);
}

async function createIndexes(db) {
  // Ordering by ts descending is the base query shape.
  // Index on (ts DESC, id DESC) supports the default ordered scan + keyset.
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC, id DESC);`);
  // Severity equality + ordering by ts.
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_sev_ts ON logs (severity, ts DESC, id DESC);`);
  // Substring search: a trigram-style GIN index is not available in base PGLite,
  // so we rely on ILIKE with the ts index for ordering. To keep substring queries
  // bounded we also add a lower(message) expression index which helps prefix cases.
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_msg_lower ON logs (lower(message));`);
  await db.exec(`ANALYZE logs;`);
}

async function isSeeded(db) {
  const res = await db.query('SELECT COUNT(*)::int AS c FROM logs;');
  return res.rows[0].c >= TARGET_ROWS;
}

async function seedIfNeeded(db) {
  if (await isSeeded(db)) {
    // Ensure indexes exist even if the table was seeded on a prior boot.
    await createIndexes(db);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`[seed] Seeding ${TARGET_ROWS} rows...`);
  const start = Date.now();

  // Clear any partial seed to keep the operation idempotent.
  await db.exec('TRUNCATE logs;');

  for (let batchStart = 0; batchStart < TARGET_ROWS; batchStart += SEED_BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + SEED_BATCH_SIZE, TARGET_ROWS);
    const values = [];
    const params = [];
    let p = 0;
    for (let id = batchStart; id < batchEnd; id++) {
      const row = buildRow(id + 1); // ids start at 1
      values.push(`($${++p}, $${++p}, $${++p}, $${++p}, $${++p})`);
      params.push(row.id, row.ts, row.severity, row.service, row.message);
    }
    await db.query(
      `INSERT INTO logs (id, ts, severity, service, message) VALUES ${values.join(',')};`,
      params
    );
  }

  await createIndexes(db);

  // eslint-disable-next-line no-console
  console.log(`[seed] Done in ${Date.now() - start}ms`);
}
