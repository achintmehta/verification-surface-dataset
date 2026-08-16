import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist the database to the local file system so restarts do not reseed.
const DATA_DIR = process.env.PGLITE_DIR
  ? path.resolve(process.env.PGLITE_DIR)
  : path.resolve(__dirname, '..', 'pgdata');

export const SEVERITIES = ['debug', 'info', 'warn', 'error'];
export const SEED_ROWS = 100_000;

// ---------------------------------------------------------------------------
// Deterministic seed corpus generation
// ---------------------------------------------------------------------------

const SERVICES = [
  'api-gateway',
  'auth-service',
  'billing-service',
  'user-service',
  'inventory-service',
  'notification-service',
  'search-service',
  'payments-service',
];

// Message templates. Each template has variable fragments so that substring
// search has both selective (rare) and non-selective (common) terms.
// The literal words in these templates (e.g. "request", "timeout") are the
// searchable substrings. "request" is very common (non-selective); a token
// like "quota" or "0x" ids are selective.
const TEMPLATES = [
  'Handled request {id} in {ms}ms',
  'Incoming request {id} from {ip}',
  'Request {id} completed with status {code}',
  'Cache miss for key {key}',
  'Cache hit for key {key}',
  'Database query {id} took {ms}ms',
  'Connection to {host} established',
  'Connection to {host} timeout after {ms}ms',
  'User {uid} authenticated successfully',
  'User {uid} failed authentication attempt',
  'Rate limit exceeded for client {cid}',
  'Quota exhausted for tenant {tid}',
  'Retrying operation {id} attempt {n}',
  'Background job {id} scheduled',
  'Background job {id} finished in {ms}ms',
  'Payment {pid} processed for {amount}',
  'Payment {pid} declined by processor',
  'Inventory item {sku} out of stock',
  'Notification {nid} dispatched to {channel}',
  'Configuration reloaded from {host}',
];

const HOSTS = ['db-primary', 'db-replica-1', 'redis-01', 'redis-02', 'kafka-broker', 'edge-node-7'];
const CHANNELS = ['email', 'sms', 'push', 'webhook'];
const STATUS_CODES = [200, 201, 204, 400, 401, 403, 404, 429, 500, 503];

// Deterministic pseudo-random generator (mulberry32) so the corpus is
// identical on every seed.
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

// Severity distribution roughly 60/25/10/5 (info/debug? spec: 60/25/10/5).
// Order in spec is severity list debug/info/warn/error; the 60/25/10/5
// distribution is assigned as info=60, debug=25, warn=10, error=5.
function pickSeverity(rng) {
  const r = rng();
  if (r < 0.6) return 'info';
  if (r < 0.85) return 'debug';
  if (r < 0.95) return 'warn';
  return 'error';
}

function fillTemplate(tpl, rng) {
  return tpl.replace(/\{(\w+)\}/g, (_, name) => {
    switch (name) {
      case 'id':
      case 'pid':
      case 'nid':
        return '0x' + Math.floor(rng() * 0xffffff).toString(16).padStart(6, '0');
      case 'ms':
        return String(Math.floor(rng() * 2000));
      case 'ip':
        return `${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}`;
      case 'code':
        return String(pick(rng, STATUS_CODES));
      case 'key':
        return 'k:' + Math.floor(rng() * 100000).toString(36);
      case 'host':
        return pick(rng, HOSTS);
      case 'uid':
      case 'cid':
      case 'tid':
        return 'u' + Math.floor(rng() * 50000);
      case 'n':
        return String(1 + Math.floor(rng() * 5));
      case 'amount':
        return '$' + (rng() * 1000).toFixed(2);
      case 'sku':
        return 'SKU-' + Math.floor(rng() * 9999).toString().padStart(4, '0');
      case 'channel':
        return pick(rng, CHANNELS);
      default:
        return 'x';
    }
  });
}

/**
 * Generate the deterministic corpus as an array of row objects.
 * Rows span 30 days ending "now-ish" but deterministic: we anchor to a fixed
 * epoch so restarts produce identical timestamps.
 */
function* generateRows() {
  const rng = mulberry32(1337);
  // Fixed anchor: 2024-01-31T00:00:00Z, spanning back 30 days.
  const endMs = Date.UTC(2024, 0, 31, 0, 0, 0);
  const spanMs = 30 * 24 * 60 * 60 * 1000;
  for (let i = 0; i < SEED_ROWS; i++) {
    // Timestamps distributed across the 30 day window. Use the index to keep
    // them broadly monotonic while jittering with rng for realism.
    const base = endMs - spanMs + Math.floor((i / SEED_ROWS) * spanMs);
    const jitter = Math.floor((rng() - 0.5) * (spanMs / SEED_ROWS) * 2);
    const ts = new Date(base + jitter).toISOString();
    const severity = pickSeverity(rng);
    const service = pick(rng, SERVICES);
    const message = fillTemplate(pick(rng, TEMPLATES), rng);
    yield { ts, severity, service, message };
  }
}

// ---------------------------------------------------------------------------
// DB init + seed
// ---------------------------------------------------------------------------

let dbInstance = null;

export async function getDb() {
  if (dbInstance) return dbInstance;
  dbInstance = new PGlite(DATA_DIR, { extensions: { pg_trgm } });
  await dbInstance.waitReady;
  return dbInstance;
}

export async function initDb() {
  const db = await getDb();

  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id       BIGSERIAL PRIMARY KEY,
      ts       TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL,
      service  TEXT NOT NULL,
      message  TEXT NOT NULL
    );
  `);

  // Detect whether the table is already populated to avoid reseeding.
  const countRes = await db.query('SELECT COUNT(*)::int AS c FROM logs;');
  const existing = countRes.rows[0]?.c ?? 0;

  if (existing < SEED_ROWS) {
    if (existing > 0) {
      // Partial / corrupt seed — start clean.
      await db.exec('TRUNCATE logs RESTART IDENTITY;');
    }
    console.log(`[db] Seeding ${SEED_ROWS} log rows...`);
    const t0 = Date.now();
    await seed(db);
    console.log(`[db] Seed complete in ${Date.now() - t0}ms`);
  } else {
    console.log(`[db] Existing corpus detected (${existing} rows) — skipping seed.`);
  }

  // Create indexes AFTER seeding (faster to build once) — idempotent.
  console.log('[db] Ensuring indexes...');
  const ti = Date.now();
  await db.exec(`
    -- Ordering by ts (descending scans use this too).
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC, id DESC);
    -- Severity equality + ordering by ts.
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC, id DESC);
    -- Case-insensitive substring search using trigram index.
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING gin (lower(message) gin_trgm_ops);
  `);
  await db.exec('ANALYZE logs;');
  console.log(`[db] Indexes ready in ${Date.now() - ti}ms`);

  return db;
}

async function seed(db) {
  const BATCH = 2000;
  let batch = [];
  const flush = async () => {
    if (batch.length === 0) return;
    // Build a multi-row INSERT with parameters.
    const values = [];
    const params = [];
    let p = 1;
    for (const r of batch) {
      values.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(r.ts, r.severity, r.service, r.message);
    }
    await db.query(
      `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')}`,
      params
    );
    batch = [];
  };

  for (const row of generateRows()) {
    batch.push(row);
    if (batch.length >= BATCH) {
      await flush();
    }
  }
  await flush();
}
