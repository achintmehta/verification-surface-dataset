import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist the database on the local file system so a restart never reseeds.
const DATA_DIR = process.env.PGLITE_DATA_DIR
  ? path.resolve(process.env.PGLITE_DATA_DIR)
  : path.resolve(__dirname, '..', 'data', 'pgdata');

export const SEVERITIES = ['debug', 'info', 'warn', 'error'];
export const TOTAL_ROWS = 100_000;
const BATCH_SIZE = 2000;

// 8 distinct services.
const SERVICES = [
  'auth-service',
  'billing-service',
  'gateway',
  'inventory-service',
  'notification-service',
  'payments-service',
  'search-service',
  'user-service',
];

// Message templates with variable fragments. Some fragments are highly
// selective (appear rarely) and some are non-selective (appear often), so the
// substring search has interesting query shapes.
const TEMPLATES = [
  'Request completed with status {code} in {ms}ms for {path}',
  'Cache {hitmiss} for key {key}',
  'Database query executed in {ms}ms rows={rows}',
  'User {user} performed {action} on resource {res}',
  'Connection to {host} {connstate} after {ms}ms',
  'Retrying operation {op} attempt {attempt} of {max}',
  'Payment {txn} {payresult} amount={amount}',
  'Rate limit {limitstate} for client {client}',
  'Background job {job} {jobstate} processed={rows} items',
  'Validation {valresult} for field {field}',
];

// Deterministic pseudo-random generator (mulberry32) so the corpus is
// identical on every fresh seed.
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

// Severity distribution roughly 60/25/10/5 (info/debug? -> per spec 60/25/10/5)
// Interpreting the four buckets as debug/info/warn/error with the largest
// bucket being the most common non-error level.
function pickSeverity(rng) {
  const r = rng();
  if (r < 0.6) return 'info';
  if (r < 0.85) return 'debug';
  if (r < 0.95) return 'warn';
  return 'error';
}

const HITMISS = ['hit', 'miss'];
const CONNSTATE = ['established', 'closed', 'refused', 'reset'];
const PAYRESULT = ['approved', 'declined', 'refunded', 'chargeback'];
const JOBSTATE = ['started', 'finished', 'failed', 'skipped'];
const VALRESULT = ['passed', 'failed'];
const LIMITSTATE = ['exceeded', 'ok'];
const ACTIONS = ['create', 'update', 'delete', 'read', 'export'];
const PATHS = ['/api/login', '/api/orders', '/api/search', '/api/profile', '/api/checkout', '/api/health'];
const FIELDS = ['email', 'password', 'amount', 'quantity', 'address'];

function buildMessage(rng, template) {
  return template
    .replace('{code}', String(pick(rng, ['200', '201', '204', '400', '401', '404', '500'])))
    .replace(/\{ms\}/g, String(1 + Math.floor(rng() * 1500)))
    .replace('{path}', pick(rng, PATHS))
    .replace('{hitmiss}', pick(rng, HITMISS))
    .replace('{key}', 'k-' + Math.floor(rng() * 100000).toString(36))
    .replace('{rows}', String(Math.floor(rng() * 5000)))
    .replace('{user}', 'user-' + (1000 + Math.floor(rng() * 9000)))
    .replace('{action}', pick(rng, ACTIONS))
    .replace('{res}', 'res-' + Math.floor(rng() * 10000))
    .replace('{host}', pick(rng, ['db-1', 'db-2', 'redis-1', 'kafka-1', 'upstream-api']))
    .replace('{connstate}', pick(rng, CONNSTATE))
    .replace('{op}', pick(rng, ['flush', 'sync', 'commit', 'fetch']))
    .replace('{attempt}', String(1 + Math.floor(rng() * 3)))
    .replace('{max}', '3')
    .replace('{txn}', 'txn-' + Math.floor(rng() * 1000000).toString(36))
    .replace('{payresult}', pick(rng, PAYRESULT))
    .replace('{amount}', (rng() * 1000).toFixed(2))
    .replace('{limitstate}', pick(rng, LIMITSTATE))
    .replace('{client}', 'client-' + Math.floor(rng() * 500))
    .replace('{job}', pick(rng, ['nightly-report', 'cleanup', 'reindex', 'digest']))
    .replace('{jobstate}', pick(rng, JOBSTATE))
    .replace('{valresult}', pick(rng, VALRESULT))
    .replace('{field}', pick(rng, FIELDS));
}

let dbInstance = null;

export async function getDb() {
  if (dbInstance) return dbInstance;
  fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });
  dbInstance = new PGlite(DATA_DIR);
  await dbInstance.waitReady;
  return dbInstance;
}

async function tableIsSeeded(db) {
  const exists = await db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'logs'
    ) AS present;
  `);
  if (!exists.rows[0]?.present) return false;
  const countRes = await db.query('SELECT COUNT(*)::int AS c FROM logs;');
  return countRes.rows[0].c >= TOTAL_ROWS;
}

async function createSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id       BIGINT PRIMARY KEY,
      ts       TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service  TEXT NOT NULL,
      message  TEXT NOT NULL
    );
  `);
}

async function createIndexes(db) {
  // Ordering by ts descending is the default query shape.
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC, id DESC);');
  // Severity equality + ordering by ts.
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_sev_ts ON logs (severity, ts DESC, id DESC);');
  // Case-insensitive substring search via trigram GIN index (if available),
  // falling back gracefully if the extension can't be created.
  try {
    await db.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
    await db.exec(
      'CREATE INDEX IF NOT EXISTS idx_logs_msg_trgm ON logs USING gin (lower(message) gin_trgm_ops);'
    );
  } catch (err) {
    console.warn('pg_trgm unavailable, substring search will use sequential scan:', err.message);
  }
}

export async function seedIfNeeded(db) {
  await createSchema(db);

  if (await tableIsSeeded(db)) {
    // Ensure indexes still exist (cheap when already present).
    await createIndexes(db);
    return { seeded: false };
  }

  console.log(`Seeding ${TOTAL_ROWS} log rows...`);
  const start = Date.now();

  const rng = makeRng(1337);

  // 30-day span ending "now" is non-deterministic; use a fixed end instant so
  // the corpus is fully deterministic across boots.
  const END_MS = Date.UTC(2024, 0, 31, 0, 0, 0); // 2024-01-31T00:00:00Z
  const SPAN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const STEP_MS = SPAN_MS / TOTAL_ROWS; // even spacing baseline

  await db.exec('BEGIN;');
  try {
    for (let batchStart = 0; batchStart < TOTAL_ROWS; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL_ROWS);
      const values = [];
      const params = [];
      let p = 0;
      for (let i = batchStart; i < batchEnd; i++) {
        // id 0 => oldest; timestamps increase with id. A little jitter keeps
        // it realistic while staying within the 30-day window and deterministic.
        const jitter = Math.floor((rng() - 0.5) * STEP_MS * 0.8);
        const ts = new Date(END_MS - SPAN_MS + i * STEP_MS + jitter);
        const severity = pickSeverity(rng);
        const service = pick(rng, SERVICES);
        const template = pick(rng, TEMPLATES);
        const message = buildMessage(rng, template);

        values.push(`($${++p},$${++p},$${++p},$${++p},$${++p})`);
        params.push(i, ts.toISOString(), severity, service, message);
      }
      await db.query(
        `INSERT INTO logs (id, ts, severity, service, message) VALUES ${values.join(',')};`,
        params
      );
    }
    await db.exec('COMMIT;');
  } catch (err) {
    await db.exec('ROLLBACK;');
    throw err;
  }

  // Build indexes after bulk load for speed.
  await createIndexes(db);
  await db.exec('ANALYZE logs;');

  console.log(`Seed complete in ${Date.now() - start}ms`);
  return { seeded: true };
}
