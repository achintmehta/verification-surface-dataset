import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist to the local file system so the corpus survives restarts.
const DATA_DIR = path.resolve(__dirname, '..', 'pgdata');

export const TOTAL_ROWS = 100_000;

const SERVICES = [
  'auth-service',
  'payment-gateway',
  'user-api',
  'search-indexer',
  'notification-worker',
  'billing-cron',
  'image-resizer',
  'session-store',
];

// Severity distribution roughly 60/25/10/5 (info/warn... per spec: debug/info/warn/error).
// Spec says "severities distributed roughly 60/25/10/5". We assign:
//   info 60, debug 25, warn 10, error 5.
const SEVERITY_WEIGHTS = [
  { severity: 'info', weight: 60 },
  { severity: 'debug', weight: 25 },
  { severity: 'warn', weight: 10 },
  { severity: 'error', weight: 5 },
];

export const SEVERITIES = ['debug', 'info', 'warn', 'error'];

// Message templates. Some fragments are selective (rare) and some non-selective (common)
// so that substring search has both selective and non-selective terms.
const TEMPLATES = [
  'request completed for endpoint /api/{res} in {ms}ms',
  'request completed for endpoint /api/{res} in {ms}ms',
  'user {uid} performed action {action}',
  'cache {hitmiss} for key {res}:{uid}',
  'database query on table {res} took {ms}ms',
  'connection pool at {pct}% capacity',
  'retrying operation {action} attempt {n}',
  'validation failed for field {res}',
  'timeout while calling downstream {svc}',
  'quota exceeded for tenant {uid}',
  'circuit breaker tripped for {svc}',
  'garbage collection paused thread for {ms}ms',
];

const RESOURCES = ['orders', 'invoices', 'accounts', 'sessions', 'tokens', 'reports', 'media', 'events'];
const ACTIONS = ['login', 'logout', 'purchase', 'refund', 'update', 'delete', 'export', 'sync'];

// Deterministic PRNG (mulberry32) so the seed is fully reproducible.
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

function pickWeightedSeverity(r) {
  // r in [0,1)
  const roll = r * 100;
  let acc = 0;
  for (const { severity, weight } of SEVERITY_WEIGHTS) {
    acc += weight;
    if (roll < acc) return severity;
  }
  return 'info';
}

function buildMessage(rand, svcIndex) {
  const tpl = TEMPLATES[Math.floor(rand() * TEMPLATES.length)];
  return tpl
    .replace('{res}', RESOURCES[Math.floor(rand() * RESOURCES.length)])
    .replace('{action}', ACTIONS[Math.floor(rand() * ACTIONS.length)])
    .replace('{uid}', String(1000 + Math.floor(rand() * 9000)))
    .replace('{ms}', String(1 + Math.floor(rand() * 800)))
    .replace('{pct}', String(1 + Math.floor(rand() * 99)))
    .replace('{n}', String(1 + Math.floor(rand() * 5)))
    .replace('{hitmiss}', rand() < 0.5 ? 'hit' : 'miss')
    .replace('{svc}', SERVICES[(svcIndex + 1 + Math.floor(rand() * 3)) % SERVICES.length]);
}

let dbInstance = null;

export async function getDb() {
  if (dbInstance) return dbInstance;
  dbInstance = new PGlite(DATA_DIR, { extensions: { pg_trgm } });
  await dbInstance.waitReady;
  return dbInstance;
}

async function tableIsSeeded(db) {
  const exists = await db.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'logs'
    ) AS present;
  `);
  if (!exists.rows[0].present) return false;
  const count = await db.query('SELECT COUNT(*)::int AS c FROM logs;');
  return count.rows[0].c === TOTAL_ROWS;
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
  // Ordering by ts (descending) plus id as a stable tiebreaker.
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts_id ON logs (ts DESC, id DESC);
  `);
  // Severity equality + ordering by ts.
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_sev_ts_id ON logs (severity, ts DESC, id DESC);
  `);
  // Trigram index for case-insensitive substring search.
  await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_message_trgm
    ON logs USING GIN (lower(message) gin_trgm_ops);
  `);
}

export async function seedIfNeeded(log = console.log) {
  const db = await getDb();

  if (await tableIsSeeded(db)) {
    log('[db] corpus already seeded; skipping seed');
    // Ensure indexes exist (cheap if present).
    await createIndexes(db);
    return db;
  }

  log('[db] seeding corpus...');
  const t0 = Date.now();

  // Fresh start: drop and recreate to guarantee an exact 100k deterministic corpus.
  await db.exec('DROP TABLE IF EXISTS logs;');
  await createSchema(db);

  const rand = mulberry32(0xC0FFEE);

  // 30 days ending "now"-ish but deterministic: pin an end anchor.
  const END_MS = Date.UTC(2024, 5, 1, 0, 0, 0); // 2024-06-01
  const SPAN_MS = 30 * 24 * 60 * 60 * 1000;
  const START_MS = END_MS - SPAN_MS;

  const BATCH = 2000;
  const COLS = 5;

  for (let start = 0; start < TOTAL_ROWS; start += BATCH) {
    const n = Math.min(BATCH, TOTAL_ROWS - start);
    const placeholders = [];
    const params = [];
    for (let i = 0; i < n; i++) {
      const id = start + i;
      // Spread timestamps deterministically across the span.
      const jitter = Math.floor(rand() * 1000);
      const tsMs = START_MS + Math.floor((id / TOTAL_ROWS) * SPAN_MS) + jitter;
      const ts = new Date(tsMs).toISOString();
      const severity = pickWeightedSeverity(rand());
      const svcIndex = Math.floor(rand() * SERVICES.length);
      const service = SERVICES[svcIndex];
      const message = buildMessage(rand, svcIndex);

      const base = i * COLS;
      placeholders.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`
      );
      params.push(id, ts, severity, service, message);
    }
    await db.query(
      `INSERT INTO logs (id, ts, severity, service, message) VALUES ${placeholders.join(',')};`,
      params
    );
  }

  log(`[db] inserted ${TOTAL_ROWS} rows in ${Date.now() - t0}ms; building indexes...`);
  await createIndexes(db);
  await db.exec('ANALYZE logs;');
  log(`[db] seed complete in ${Date.now() - t0}ms`);

  return db;
}
