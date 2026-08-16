'use strict';

const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const DATA_DIR = path.join(__dirname, '..', 'pgdata');

const TOTAL_ROWS = 100000;
const NUM_SERVICES = 8;
const DAYS_SPAN = 30;
const BATCH_SIZE = 2000;

const SEVERITIES = ['debug', 'info', 'warn', 'error'];

// Roughly 60/25/10/5 distribution.
// We build a cumulative table for deterministic assignment.
const SEVERITY_WEIGHTS = [
  { sev: 'info', w: 60 },
  { sev: 'debug', w: 25 },
  { sev: 'warn', w: 10 },
  { sev: 'error', w: 5 },
];

const SERVICES = [
  'auth-service',
  'payment-gateway',
  'inventory-api',
  'notification-worker',
  'search-index',
  'user-profile',
  'billing-engine',
  'gateway-router',
];

// Message templates with variable fragments. Some fragments are selective
// (rare) and others non-selective (common) so substring search has both.
const MESSAGE_TEMPLATES = [
  'Request completed for endpoint {endpoint} in {ms}ms',
  'Cache {cacheresult} for key {key}',
  'Database query on table {table} returned {count} rows',
  'User {userid} performed action {action}',
  'Retrying operation {operation} attempt {attempt}',
  'Connection to {host} {connstate}',
  'Processed message {msgid} from queue {queue}',
  'Validation {valresult} for field {field}',
  'Timeout waiting for {resource} after {ms}ms',
  'Health check {healthresult} for component {component}',
];

const ENDPOINTS = ['/api/v1/users', '/api/v1/orders', '/api/v1/search', '/api/v1/payments', '/healthz'];
const CACHE_RESULTS = ['hit', 'miss', 'evicted'];
const TABLES = ['accounts', 'transactions', 'sessions', 'audit_log', 'products'];
const ACTIONS = ['login', 'logout', 'purchase', 'update_profile', 'delete_account'];
const OPERATIONS = ['sync', 'reindex', 'flush', 'reconcile'];
const HOSTS = ['db-primary', 'db-replica-1', 'cache-node-3', 'queue-broker'];
const CONN_STATES = ['established', 'refused', 'timed out', 'reset'];
const QUEUES = ['high-priority', 'default', 'dead-letter'];
const FIELDS = ['email', 'amount', 'quantity', 'token', 'phone'];
const RESOURCES = ['lock', 'downstream service', 'external API', 'file handle'];
const HEALTH_RESULTS = ['passed', 'failed', 'degraded'];
const COMPONENTS = ['scheduler', 'worker-pool', 'connection-pool', 'metrics-exporter'];

// A small deterministic PRNG (mulberry32).
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

function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

function buildSeverityLookup() {
  // Return a function mapping a value in [0,1) to a severity, deterministic.
  const totalW = SEVERITY_WEIGHTS.reduce((s, x) => s + x.w, 0);
  const cum = [];
  let acc = 0;
  for (const { sev, w } of SEVERITY_WEIGHTS) {
    acc += w / totalW;
    cum.push({ sev, upto: acc });
  }
  return (r) => {
    for (const c of cum) {
      if (r < c.upto) return c.sev;
    }
    return cum[cum.length - 1].sev;
  };
}

function buildMessage(rand, templateIdx) {
  const tmpl = MESSAGE_TEMPLATES[templateIdx];
  return tmpl.replace(/\{(\w+)\}/g, (_, tok) => {
    switch (tok) {
      case 'endpoint': return pick(rand, ENDPOINTS);
      case 'ms': return String(1 + Math.floor(rand() * 5000));
      case 'cacheresult': return pick(rand, CACHE_RESULTS);
      case 'key': return 'k:' + Math.floor(rand() * 100000).toString(16);
      case 'table': return pick(rand, TABLES);
      case 'count': return String(Math.floor(rand() * 10000));
      case 'userid': return String(10000 + Math.floor(rand() * 90000));
      case 'action': return pick(rand, ACTIONS);
      case 'operation': return pick(rand, OPERATIONS);
      case 'attempt': return String(1 + Math.floor(rand() * 5));
      case 'host': return pick(rand, HOSTS);
      case 'connstate': return pick(rand, CONN_STATES);
      case 'msgid': return 'msg-' + Math.floor(rand() * 1000000).toString(36);
      case 'queue': return pick(rand, QUEUES);
      case 'valresult': return rand() < 0.5 ? 'succeeded' : 'failed';
      case 'field': return pick(rand, FIELDS);
      case 'resource': return pick(rand, RESOURCES);
      case 'healthresult': return pick(rand, HEALTH_RESULTS);
      case 'component': return pick(rand, COMPONENTS);
      default: return tok;
    }
  });
}

let dbInstance = null;

async function getDb() {
  if (dbInstance) return dbInstance;
  dbInstance = new PGlite(DATA_DIR);
  await dbInstance.waitReady;
  return dbInstance;
}

async function tableExists(db) {
  const res = await db.query(
    "SELECT to_regclass('public.logs') IS NOT NULL AS exists"
  );
  return !!(res.rows[0] && res.rows[0].exists);
}

async function hasExpectedSchema(db) {
  const res = await db.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'logs'
  `);
  const cols = new Set(res.rows.map((r) => r.column_name));
  return ['id', 'ts', 'severity', 'service', 'message', 'message_lc'].every((c) =>
    cols.has(c)
  );
}

async function isSeeded(db) {
  if (!(await tableExists(db))) return false;
  if (!(await hasExpectedSchema(db))) return false;
  const cnt = await db.query('SELECT COUNT(*)::int AS c FROM logs');
  return cnt.rows[0].c >= TOTAL_ROWS;
}

async function createSchema(db) {
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
}

async function createIndexes(db) {
  // Ordering index: primary sort is ts DESC, id DESC as tiebreak for stable
  // keyset/offset ordering.
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC, id DESC);
  `);
  // Severity + ordering: severity equality then ordering by ts.
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_sev_ts ON logs (severity, ts DESC, id DESC);
  `);
  // Substring search strategy: trigram index for case-insensitive ILIKE.
  // Substring search strategy:
  // pg_trgm is not available in this PGlite build, so we cannot build a GIN
  // trigram index for arbitrary substrings. Instead, substring queries rely
  // on the ts-ordered index (idx_logs_ts): PostgreSQL walks the index in
  // ts DESC order and applies the message_lc LIKE filter as a streaming
  // predicate, letting LIMIT/OFFSET terminate the scan early rather than
  // sorting the whole matching set. The message_lc column stores the
  // pre-lowercased message so the filter is a plain LIKE with no per-row
  // lower() call. We attempt pg_trgm opportunistically in case it is present.
  try {
    await db.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_message_trgm
      ON logs USING gin (message_lc gin_trgm_ops);
    `);
  } catch (e) {
    // pg_trgm may be unavailable in some PGlite builds; fall back gracefully.
    // The query still works correctly via the ts-ordered streaming scan.
    // eslint-disable-next-line no-console
    console.warn('pg_trgm unavailable; using ts-ordered streaming scan for substring search.');
  }
}

async function seed(db) {
  const rand = mulberry32(0x9e3779b9);
  const sevLookup = buildSeverityLookup();

  const startMs = Date.UTC(2024, 0, 1, 0, 0, 0); // fixed anchor for determinism
  const spanMs = DAYS_SPAN * 24 * 60 * 60 * 1000;

  await db.exec('BEGIN');
  try {
    let batchValues = [];
    let batchParams = [];
    let paramIdx = 1;

    const flush = async () => {
      if (batchValues.length === 0) return;
      const sql =
        'INSERT INTO logs (id, ts, severity, service, message, message_lc) VALUES ' +
        batchValues.join(',');
      await db.query(sql, batchParams);
      batchValues = [];
      batchParams = [];
      paramIdx = 1;
    };

    for (let i = 0; i < TOTAL_ROWS; i++) {
      // Deterministic timestamp spread across the span. Interleave so that
      // ts is not strictly monotonic with id (realistic ordering).
      const tsMs = startMs + Math.floor(rand() * spanMs);
      const ts = new Date(tsMs).toISOString();
      const severity = sevLookup(rand());
      const service = SERVICES[i % NUM_SERVICES];
      const templateIdx = Math.floor(rand() * MESSAGE_TEMPLATES.length);
      const message = buildMessage(rand, templateIdx);

      batchValues.push(
        `($${paramIdx},$${paramIdx + 1},$${paramIdx + 2},$${paramIdx + 3},$${paramIdx + 4},$${paramIdx + 5})`
      );
      batchParams.push(i + 1, ts, severity, service, message, message.toLowerCase());
      paramIdx += 6;

      if (batchValues.length >= BATCH_SIZE) {
        await flush();
      }
    }
    await flush();
    await db.exec('COMMIT');
  } catch (e) {
    await db.exec('ROLLBACK');
    throw e;
  }
}

async function initDb() {
  const db = await getDb();
  // If a table exists with an outdated schema, drop it so we can reseed
  // against the current schema (idempotent for fresh installs).
  if ((await tableExists(db)) && !(await hasExpectedSchema(db))) {
    // eslint-disable-next-line no-console
    console.log('Outdated schema detected, recreating logs table.');
    await db.exec('DROP TABLE IF EXISTS logs;');
  }
  await createSchema(db);
  const seeded = await isSeeded(db);
  if (!seeded) {
    const t0 = Date.now();
    // eslint-disable-next-line no-console
    console.log('Seeding %d rows...', TOTAL_ROWS);
    await seed(db);
    await createIndexes(db);
    await db.exec('ANALYZE logs;');
    // eslint-disable-next-line no-console
    console.log('Seed complete in %dms', Date.now() - t0);
  } else {
    // Ensure indexes exist even on subsequent boots (cheap if present).
    await createIndexes(db);
    // eslint-disable-next-line no-console
    console.log('Corpus already seeded, skipping.');
  }
  return db;
}

module.exports = {
  getDb,
  initDb,
  SEVERITIES,
  TOTAL_ROWS,
};
