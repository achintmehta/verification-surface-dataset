import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persistent on-disk data directory so the corpus survives restarts.
const DATA_DIR = process.env.PGLITE_DIR || path.join(__dirname, '..', 'pgdata');

export const SEVERITIES = ['debug', 'info', 'warn', 'error'];
export const TOTAL_ROWS = 100_000;
const DAYS_SPAN = 30;
const SERVICES = [
  'auth-service',
  'payment-gateway',
  'user-api',
  'notification-worker',
  'search-indexer',
  'image-processor',
  'billing-cron',
  'edge-proxy',
];

// Message templates with variable fragments. Some fragments are selective
// (rare) and some are non-selective (common), so substring search has both.
const TEMPLATES = [
  'request completed for endpoint {endpoint} in {ms}ms',
  'request failed for endpoint {endpoint} status {code}',
  'connection to {host} established',
  'connection to {host} timed out after {ms}ms',
  'cache {hitmiss} for key {key}',
  'user {uid} performed action {action}',
  'retrying operation {action} attempt {n}',
  'queue depth {n} for worker {host}',
  'slow query detected {ms}ms on table {key}',
  'token validated for user {uid}',
];

const ENDPOINTS = ['/v1/login', '/v1/pay', '/v1/users', '/v1/search', '/v1/upload', '/v1/health'];
const HOSTS = ['db-primary', 'db-replica-1', 'redis-cache', 'kafka-broker', 'upstream-cdn'];
const ACTIONS = ['create', 'update', 'delete', 'export', 'purge'];
const HITMISS = ['hit', 'miss'];
const CODES = ['500', '502', '503', '429', '404'];
const KEYS = ['sessions', 'invoices', 'catalog', 'thumbnails', 'audit_log'];

// Deterministic pseudo-random generator (mulberry32).
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

// Distribution roughly 60/25/10/5 for debug/info/warn/error.
function pickSeverity(rng) {
  const r = rng();
  if (r < 0.6) return 'debug';
  if (r < 0.85) return 'info';
  if (r < 0.95) return 'warn';
  return 'error';
}

function buildMessage(rng) {
  const tpl = pick(rng, TEMPLATES);
  return tpl
    .replace('{endpoint}', pick(rng, ENDPOINTS))
    .replace('{host}', pick(rng, HOSTS))
    .replace('{action}', pick(rng, ACTIONS))
    .replace('{hitmiss}', pick(rng, HITMISS))
    .replace('{code}', pick(rng, CODES))
    .replace('{key}', pick(rng, KEYS))
    .replace('{ms}', String(Math.floor(rng() * 5000)))
    .replace('{n}', String(Math.floor(rng() * 500)))
    .replace('{uid}', String(10000 + Math.floor(rng() * 90000)));
}

let dbInstance = null;

export async function getDb() {
  if (dbInstance) return dbInstance;
  dbInstance = new PGlite(DATA_DIR);
  await dbInstance.waitReady;
  return dbInstance;
}

async function tableSeeded(db) {
  const res = await db.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'logs'
    ) AS present;
  `);
  if (!res.rows[0].present) return false;
  const count = await db.query('SELECT COUNT(*)::int AS c FROM logs;');
  return count.rows[0].c >= TOTAL_ROWS;
}

export async function initDb() {
  const db = await getDb();

  if (await tableSeeded(db)) {
    // Already seeded on a previous boot — skip reseeding entirely.
    await ensureIndexes(db);
    return db;
  }

  await db.exec(`
    DROP TABLE IF EXISTS logs;
    CREATE TABLE logs (
      id       BIGINT PRIMARY KEY,
      ts       TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL,
      service  TEXT NOT NULL,
      message  TEXT NOT NULL
    );
  `);

  await seed(db);
  await ensureIndexes(db);
  return db;
}

async function ensureIndexes(db) {
  // Indexes chosen for the two query shapes:
  //  - ordering by ts desc (primary window scroll)
  //  - severity equality + ordering by ts
  //  - substring (trigram-like) search: PGLite has pg_trgm available.
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_sev_ts ON logs (severity, ts DESC, id DESC);
  `);
  // Try to enable trigram index for fast case-insensitive substring search.
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_msg_trgm
      ON logs USING gin (lower(message) gin_trgm_ops);
    `);
  } catch (e) {
    // Trigram extension unavailable — queries still work, just slower on
    // non-selective substrings. Ordering/severity indexes still apply.
    console.warn('pg_trgm not available, substring search will use sequential scan:', e.message);
  }
}

async function seed(db) {
  const rng = makeRng(1234567);
  const startMs = Date.UTC(2024, 0, 1, 0, 0, 0);
  const spanMs = DAYS_SPAN * 24 * 60 * 60 * 1000;
  const step = spanMs / TOTAL_ROWS;

  const BATCH = 2000;
  await db.exec('BEGIN;');
  let values = [];
  let params = [];
  let paramIdx = 1;

  const flush = async () => {
    if (values.length === 0) return;
    const sql = `INSERT INTO logs (id, ts, severity, service, message) VALUES ${values.join(',')};`;
    await db.query(sql, params);
    values = [];
    params = [];
    paramIdx = 1;
  };

  for (let i = 0; i < TOTAL_ROWS; i++) {
    // Deterministic ascending timestamp so ts ordering is meaningful.
    const ts = new Date(startMs + Math.floor(i * step)).toISOString();
    const severity = pickSeverity(rng);
    const service = pick(rng, SERVICES);
    const message = buildMessage(rng);

    values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
    params.push(i, ts, severity, service, message);

    if (values.length >= BATCH) {
      await flush();
    }
  }
  await flush();
  await db.exec('COMMIT;');
}
