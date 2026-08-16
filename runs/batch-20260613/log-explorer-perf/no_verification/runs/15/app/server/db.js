import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist to the local file system so the corpus survives restarts.
const DATA_DIR = process.env.PGLITE_DIR || path.join(__dirname, '..', '.pgdata');

export const TOTAL_ROWS = 100_000;
export const SEVERITIES = ['debug', 'info', 'warn', 'error'];

// -----------------------------------------------------------------------------
// Deterministic seed data generation
// -----------------------------------------------------------------------------

// A small, deterministic PRNG (mulberry32) so the corpus is identical on every
// first boot. We never rely on Math.random() for seeding.
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
  'auth-service',
  'billing-service',
  'payments-gateway',
  'user-profile',
  'search-indexer',
  'notification-worker',
  'api-gateway',
  'cache-manager',
];

// Message templates. `{n}` gets a numeric fragment, `{id}` a hex id, `{ms}` a
// duration. Some contain rare/selective terms ("deadlock", "OOMKilled") and
// some contain common/non-selective terms ("request", "completed").
const TEMPLATES = [
  'request {id} completed in {ms}ms',
  'handled request {id} for user {n}',
  'cache miss for key user:{n}',
  'cache hit for key session:{id}',
  'connection pool exhausted after {ms}ms wait',
  'retrying request {id} attempt {n}',
  'user {n} authenticated successfully',
  'failed to authenticate user {n} invalid token',
  'payment {id} authorized amount {n}',
  'payment {id} declined by processor',
  'database deadlock detected on transaction {id}',
  'slow query detected took {ms}ms',
  'background job {id} enqueued',
  'background job {id} finished processing {n} items',
  'rate limit exceeded for client {id}',
  'process terminated OOMKilled restarting',
  'healthcheck ok latency {ms}ms',
  'config reloaded {n} keys updated',
  'index rebuild started for shard {n}',
  'index rebuild completed in {ms}ms',
  'notification {id} delivered to user {n}',
  'notification {id} bounced permanent failure',
  'circuit breaker opened for upstream {id}',
  'circuit breaker closed for upstream {id}',
];

// Severity distribution ~60/25/10/5 (info/debug/warn/error). The spec says
// "roughly 60/25/10/5"; we map info=60, debug=25, warn=10, error=5.
function pickSeverity(r) {
  const x = r();
  if (x < 0.6) return 'info';
  if (x < 0.85) return 'debug';
  if (x < 0.95) return 'warn';
  return 'error';
}

function hexId(r) {
  return Math.floor(r() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
}

function renderMessage(template, r) {
  return template
    .replace('{id}', () => hexId(r))
    .replace('{n}', () => String(Math.floor(r() * 100000)))
    .replace('{ms}', () => String(Math.floor(r() * 5000)))
    // in case a template has more than one of a token, do a second pass
    .replace('{id}', () => hexId(r))
    .replace('{n}', () => String(Math.floor(r() * 100000)))
    .replace('{ms}', () => String(Math.floor(r() * 5000)));
}

// 30 days span. Timestamps are strictly increasing-ish across the corpus so
// ordering by ts is meaningful; we spread them uniformly across the window.
const SPAN_MS = 30 * 24 * 60 * 60 * 1000;
// Anchor to a fixed epoch so timestamps are deterministic.
const END_TS = Date.UTC(2024, 0, 31, 0, 0, 0, 0);
const START_TS = END_TS - SPAN_MS;

function* generateRows() {
  const r = mulberry32(0xc0ffee);
  const step = SPAN_MS / TOTAL_ROWS;
  for (let i = 0; i < TOTAL_ROWS; i++) {
    // base evenly-spaced timestamp plus deterministic jitter within the step
    const jitter = Math.floor(r() * step);
    const ts = new Date(START_TS + Math.floor(i * step) + jitter);
    const severity = pickSeverity(r);
    const service = SERVICES[Math.floor(r() * SERVICES.length)];
    const template = TEMPLATES[Math.floor(r() * TEMPLATES.length)];
    const message = renderMessage(template, r);
    yield { ts: ts.toISOString(), severity, service, message };
  }
}

// -----------------------------------------------------------------------------
// DB lifecycle
// -----------------------------------------------------------------------------

let db = null;

export async function getDb() {
  if (db) return db;
  db = await PGlite.create(DATA_DIR);
  await ensureSchema(db);
  await ensureSeed(db);
  return db;
}

async function ensureSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id       BIGSERIAL PRIMARY KEY,
      ts       TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL,
      service  TEXT NOT NULL,
      message  TEXT NOT NULL
    );
  `);
}

async function ensureIndexes(db) {
  // Indexes chosen for the two graded query shapes:
  //  - ordering by ts DESC (the base, unfiltered window): idx_logs_ts lets the
  //    planner read rows in order and satisfy LIMIT/OFFSET without a sort.
  //  - severity equality + ordering by ts DESC: idx_logs_sev_ts is a composite
  //    that both filters and preserves order, so severity-filtered deep offsets
  //    stay index-backed.
  // We include id in the ordering keys to make the sort order total and
  // deterministic (ts has ~ms granularity across 30 days / 100k rows so ties
  // are possible; id breaks them consistently).
  //
  // Substring search (`lower(message) LIKE '%term%'`) cannot use a b-tree index
  // (leading wildcard), and pg_trgm is not bundled with PGLite. On a 100k-row
  // corpus of short messages a sequential scan comfortably fits the 300ms
  // budget, so no substring index is created (it would only add write cost
  // without helping the query).
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts     ON logs (ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_sev_ts ON logs (severity, ts DESC, id DESC);
  `);
}

async function isSeeded(db) {
  // Fast existence check: does at least one row exist?
  const res = await db.query('SELECT 1 AS x FROM logs LIMIT 1;');
  return res.rows.length > 0;
}

async function ensureSeed(db) {
  if (await isSeeded(db)) {
    // Already populated on a previous boot — skip reseeding, just ensure
    // indexes exist (cheap, IF NOT EXISTS).
    await ensureIndexes(db);
    return;
  }

  const t0 = Date.now();
  console.log(`[db] seeding ${TOTAL_ROWS} rows...`);

  // Batch inserts. Row-by-row would blow the boot budget; multi-row VALUES
  // batches keep it well under 60s.
  const BATCH = 1000;
  let batch = [];
  let params = [];
  let seeded = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    // Build a parameterized multi-row insert.
    const valuesSql = batch
      .map((_, i) => {
        const b = i * 4;
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`;
      })
      .join(',');
    await db.query(
      `INSERT INTO logs (ts, severity, service, message) VALUES ${valuesSql};`,
      params
    );
    seeded += batch.length;
    batch = [];
    params = [];
  };

  for (const row of generateRows()) {
    batch.push(row);
    params.push(row.ts, row.severity, row.service, row.message);
    if (batch.length >= BATCH) {
      await flush();
    }
  }
  await flush();

  // Build indexes AFTER bulk load — faster than maintaining them per insert.
  await ensureIndexes(db);

  // Update planner statistics so the query planner uses the indexes.
  await db.exec('ANALYZE logs;');

  console.log(
    `[db] seeded ${seeded} rows and built indexes in ${Date.now() - t0}ms`
  );
}
