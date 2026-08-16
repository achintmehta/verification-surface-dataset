import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persistent on-disk PGLite database so the corpus survives restarts.
const DATA_DIR = path.join(__dirname, '..', '.pgdata');

const TOTAL_ROWS = 100_000;
const BATCH_SIZE = 2_000;
const NUM_DAYS = 30;
const SERVICES = [
  'auth-service',
  'payment-gateway',
  'user-api',
  'inventory',
  'search-indexer',
  'notification',
  'billing',
  'edge-proxy',
];

// Severity distribution ~ 60 / 25 / 10 / 5 (info/debug is flexible; spec says
// severities in debug/info/warn/error distributed roughly 60/25/10/5).
// We map: info 60, debug 25, warn 10, error 5.
const SEVERITY_BUCKETS = [
  { severity: 'info', weight: 60 },
  { severity: 'debug', weight: 25 },
  { severity: 'warn', weight: 10 },
  { severity: 'error', weight: 5 },
];

// Message templates with both selective and non-selective fragments.
// Non-selective terms (e.g. "request") appear in many rows; selective terms
// (e.g. a specific error code) appear rarely.
const TEMPLATES = {
  info: [
    'Handled request for user {user} in {ms}ms',
    'Cache hit for key {key}',
    'Processed request batch of {n} items',
    'User {user} logged in from {ip}',
    'Health check passed for node {node}',
  ],
  debug: [
    'Trace span {span} started for request {req}',
    'Config value {key} resolved to {val}',
    'Retrying connection to {node} attempt {n}',
    'Serializing payload of {n} bytes',
    'Debug snapshot {span} committed',
  ],
  warn: [
    'Slow query detected {ms}ms for request {req}',
    'Deprecated API used by user {user}',
    'Connection pool near capacity {n} of 100',
    'Rate limit approaching for ip {ip}',
    'Retry threshold reached for node {node}',
  ],
  error: [
    'Unhandled exception ERR_{code} in request {req}',
    'Database timeout ERR_{code} after {ms}ms',
    'Payment declined ERR_{code} for user {user}',
    'Failed to reach node {node} ERR_{code}',
    'Validation failed ERR_{code} for payload',
  ],
};

// Deterministic PRNG (mulberry32) so the seed is fully reproducible.
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

function pickSeverity(rng) {
  const r = rng() * 100;
  let acc = 0;
  for (const b of SEVERITY_BUCKETS) {
    acc += b.weight;
    if (r < acc) return b.severity;
  }
  return 'info';
}

function fillTemplate(tpl, rng) {
  return tpl.replace(/\{(\w+)\}/g, (_, token) => {
    switch (token) {
      case 'user':
        return 'u' + Math.floor(rng() * 5000);
      case 'ms':
        return String(1 + Math.floor(rng() * 3000));
      case 'key':
        return 'cfg.' + ['timeout', 'region', 'shard', 'ttl', 'limit'][Math.floor(rng() * 5)];
      case 'n':
        return String(1 + Math.floor(rng() * 500));
      case 'ip':
        return `10.${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}`;
      case 'node':
        return 'node-' + Math.floor(rng() * 32);
      case 'span':
        return 'sp' + Math.floor(rng() * 100000).toString(16);
      case 'req':
        return 'rq' + Math.floor(rng() * 1000000).toString(16);
      case 'val':
        return ['true', 'false', 'auto', 'strict'][Math.floor(rng() * 4)];
      case 'code':
        // Selective terms: specific error codes appear rarely.
        return String(1000 + Math.floor(rng() * 50));
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
  await initSchema(dbInstance);
  await seedIfNeeded(dbInstance);
  return dbInstance;
}

async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id       INTEGER PRIMARY KEY,
      ts       TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service  TEXT NOT NULL,
      message  TEXT NOT NULL
    );
  `);
}

async function createIndexes(db) {
  // Ordering by ts (desc scans supported by btree), severity + ordering,
  // and a trigram index for case-insensitive substring search.
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts        ON logs (ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_sev_ts    ON logs (severity, ts DESC, id DESC);
  `);
  // pg_trgm greatly speeds up ILIKE '%...%'. Fall back gracefully if the
  // extension/index is unavailable in this PGLite build.
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_msg_trgm
        ON logs USING gin (lower(message) gin_trgm_ops);
    `);
  } catch (err) {
    console.warn('[db] pg_trgm not available, substring search will use scan:', err.message);
  }
}

async function isSeeded(db) {
  const res = await db.query(`SELECT COUNT(*)::int AS c FROM logs;`);
  return res.rows[0].c >= TOTAL_ROWS;
}

async function seedIfNeeded(db) {
  if (await isSeeded(db)) {
    console.log('[db] corpus already seeded, skipping seed.');
    // Ensure indexes exist (cheap if already present).
    await createIndexes(db);
    return;
  }

  console.log('[db] seeding %d rows...', TOTAL_ROWS);
  const t0 = Date.now();

  // Start from a clean table in case of a partial prior seed.
  await db.exec(`TRUNCATE logs;`);

  const rng = makeRng(0x1234abcd);
  const startMs = Date.UTC(2024, 0, 1, 0, 0, 0); // deterministic epoch
  const spanMs = NUM_DAYS * 24 * 60 * 60 * 1000;
  // Timestamps increase with id so ordering by ts desc == ordering by id desc.
  const stepMs = Math.floor(spanMs / TOTAL_ROWS);

  for (let start = 0; start < TOTAL_ROWS; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE, TOTAL_ROWS);
    const values = [];
    const params = [];
    let p = 0;
    for (let i = start; i < end; i++) {
      const severity = pickSeverity(rng);
      const service = SERVICES[Math.floor(rng() * SERVICES.length)];
      const templates = TEMPLATES[severity];
      const tpl = templates[Math.floor(rng() * templates.length)];
      const message = fillTemplate(tpl, rng);
      // add a little jitter within the step so ties are rare
      const ts = new Date(startMs + i * stepMs + Math.floor(rng() * stepMs)).toISOString();
      values.push(`($${++p},$${++p},$${++p},$${++p},$${++p})`);
      params.push(i, ts, severity, service, message);
    }
    await db.query(
      `INSERT INTO logs (id, ts, severity, service, message) VALUES ${values.join(',')};`,
      params,
    );
  }

  console.log('[db] rows inserted in %dms, building indexes...', Date.now() - t0);
  await createIndexes(db);
  await db.exec(`ANALYZE logs;`);
  console.log('[db] seed complete in %dms', Date.now() - t0);
}

export const config = { TOTAL_ROWS, SERVICES, MAX_LIMIT: 200 };
export const SEVERITIES = ['debug', 'info', 'warn', 'error'];
