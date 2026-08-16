import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist to local filesystem so the corpus survives restarts.
const DATA_DIR = path.join(__dirname, '..', 'pgdata');

const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SERVICES = [
  'auth-service',
  'payment-gateway',
  'order-service',
  'inventory',
  'notification',
  'search-index',
  'user-profile',
  'analytics',
];

// Message templates with variable fragments. Some fragments are highly
// selective (rare) and some are non-selective (appear in many rows) so that
// substring search has both cheap and expensive query shapes.
const TEMPLATES = [
  'Request processed for user {uid} in {ms}ms',
  'Connection established to node {node}',
  'Cache miss for key session:{uid}',
  'Cache hit for key session:{uid}',
  'Retrying operation {op} attempt {n}',
  'Timeout waiting for downstream {node}',
  'Payload validation succeeded for txn {txn}',
  'Payload validation failed for txn {txn}',
  'Rate limit exceeded for client {uid}',
  'Background job {op} completed in {ms}ms',
  'Database query {op} returned {n} rows',
  'Circuit breaker OPEN for {node}',
  'Deprecated API endpoint accessed by {uid}',
  'Health check passed for {node}',
  'Unexpected null reference in handler {op}',
  'Flushing buffer of {n} events to {node}',
];

// Deterministic pseudo-random generator (mulberry32) — same seed => same corpus.
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

const TOTAL_ROWS = 100000;
const DAYS_SPAN = 30;

// Distribution ~60/25/10/5 for debug/info/warn/error.
function severityFor(r) {
  if (r < 0.6) return 'debug';
  if (r < 0.85) return 'info';
  if (r < 0.95) return 'warn';
  return 'error';
}

function buildMessage(rand, tpl) {
  return tpl
    .replace('{uid}', String(1000 + Math.floor(rand() * 9000)))
    .replace('{ms}', String(1 + Math.floor(rand() * 5000)))
    .replace('{node}', 'node-' + Math.floor(rand() * 32))
    .replace('{op}', ['sync', 'reindex', 'purge', 'export', 'compact'][Math.floor(rand() * 5)])
    .replace('{n}', String(Math.floor(rand() * 500)))
    .replace('{txn}', 'txn_' + (100000 + Math.floor(rand() * 900000)));
}

let dbInstance = null;

export async function getDb() {
  if (dbInstance) return dbInstance;
  const db = new PGlite(DATA_DIR);
  await db.waitReady;
  await ensureSchema(db);
  await ensureSeed(db);
  dbInstance = db;
  return db;
}

async function ensureSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id       BIGINT PRIMARY KEY,
      ts       TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service  TEXT NOT NULL,
      message  TEXT NOT NULL
    );
  `);

  // Ordering index (ts DESC, id DESC) to make the default sort and deep
  // offsets index-backed. id as tiebreaker gives a stable total order.
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC, id DESC);`);
  // Severity equality + ordering.
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_sev_ts ON logs (severity, ts DESC, id DESC);`);
  // Substring search: trigram GIN index for fast case-insensitive ILIKE.
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_logs_msg_trgm ON logs USING gin (message gin_trgm_ops);`
    );
  } catch (e) {
    // pg_trgm may not be bundled; fall back to a lower(message) index.
    console.warn('pg_trgm unavailable, falling back to lower(message) index:', e.message);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_msg_lower ON logs (lower(message));`);
  }
}

async function ensureSeed(db) {
  const res = await db.query('SELECT COUNT(*)::int AS c FROM logs;');
  const count = res.rows[0].c;
  if (count >= TOTAL_ROWS) {
    console.log(`[seed] table already populated with ${count} rows, skipping seed.`);
    return;
  }
  if (count > 0) {
    console.log(`[seed] partial table (${count} rows) detected, resetting for clean seed.`);
    await db.exec('TRUNCATE logs;');
  }

  console.log(`[seed] seeding ${TOTAL_ROWS} rows...`);
  const t0 = Date.now();

  const rand = mulberry32(0x1234abcd);
  const start = Date.UTC(2024, 0, 1, 0, 0, 0); // deterministic start
  const spanMs = DAYS_SPAN * 24 * 60 * 60 * 1000;

  const BATCH = 1000;
  await db.exec('BEGIN;');
  try {
    let values = [];
    let params = [];
    let pIdx = 1;
    let batched = 0;

    const flush = async () => {
      if (values.length === 0) return;
      const sql =
        'INSERT INTO logs (id, ts, severity, service, message) VALUES ' +
        values.join(',') + ';';
      await db.query(sql, params);
      values = [];
      params = [];
      pIdx = 1;
      batched = 0;
    };

    for (let i = 0; i < TOTAL_ROWS; i++) {
      const ts = new Date(start + Math.floor((i / TOTAL_ROWS) * spanMs) + Math.floor(rand() * 1000));
      const severity = severityFor(rand());
      const service = SERVICES[Math.floor(rand() * SERVICES.length)];
      const tpl = TEMPLATES[Math.floor(rand() * TEMPLATES.length)];
      const message = buildMessage(rand, tpl);

      values.push(`($${pIdx++},$${pIdx++},$${pIdx++},$${pIdx++},$${pIdx++})`);
      params.push(i, ts.toISOString(), severity, service, message);
      batched++;
      if (batched >= BATCH) await flush();
    }
    await flush();
    await db.exec('COMMIT;');
  } catch (e) {
    await db.exec('ROLLBACK;');
    throw e;
  }

  console.log(`[seed] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

export { SEVERITIES };
