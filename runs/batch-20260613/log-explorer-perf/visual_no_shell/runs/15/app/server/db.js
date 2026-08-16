import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEED_TARGET = 100000;
const DATA_DIR = path.join(__dirname, '..', 'data', 'pgdata');

// -----------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) so the corpus is identical on every seed.
// -----------------------------------------------------------------------------
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
  'payment-gateway',
  'order-processor',
  'inventory-sync',
  'notification-hub',
  'user-profile',
  'search-index',
  'api-gateway',
];

// Message templates with variable fragments. Some fragments are highly selective
// (rare tokens) and some are non-selective (appear across many rows).
const TEMPLATES = [
  'Request completed for endpoint {endpoint} in {ms}ms',
  'User {uid} authenticated via {method}',
  'Cache {hitmiss} for key {key}',
  'Database query on table {table} took {ms}ms',
  'Retrying operation {op} attempt {n}',
  'Payment {status} for transaction {txn}',
  'Inventory level for SKU {sku} updated to {qty}',
  'Connection to {host} {connstate}',
  'Rate limit {limitstate} for client {uid}',
  'Background job {op} finished with status {status}',
];

const ENDPOINTS = ['/v1/users', '/v1/orders', '/v1/payments', '/v1/search', '/v1/health'];
const METHODS = ['oauth', 'password', 'sso', 'apikey'];
const HITMISS = ['hit', 'miss'];
const TABLES = ['users', 'orders', 'payments', 'sessions', 'inventory'];
const OPS = ['reindex', 'flush', 'compact', 'export', 'cleanup'];
const STATUS = ['succeeded', 'failed', 'pending', 'cancelled'];
const CONNSTATE = ['established', 'dropped', 'refused', 'timed out'];
const LIMITSTATE = ['exceeded', 'ok'];

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function buildMessage(rng, tplIndex) {
  const tpl = TEMPLATES[tplIndex];
  return tpl
    .replace('{endpoint}', () => pick(rng, ENDPOINTS))
    .replace('{ms}', () => String(1 + Math.floor(rng() * 2000)))
    .replace('{uid}', () => 'u' + (1000 + Math.floor(rng() * 9000)))
    .replace('{method}', () => pick(rng, METHODS))
    .replace('{hitmiss}', () => pick(rng, HITMISS))
    .replace('{key}', () => 'k:' + Math.floor(rng() * 100000).toString(16))
    .replace('{table}', () => pick(rng, TABLES))
    .replace('{op}', () => pick(rng, OPS))
    .replace('{n}', () => String(1 + Math.floor(rng() * 5)))
    .replace('{status}', () => pick(rng, STATUS))
    .replace('{txn}', () => 'txn_' + Math.floor(rng() * 1000000).toString(36))
    .replace('{sku}', () => 'SKU-' + (10000 + Math.floor(rng() * 90000)))
    .replace('{qty}', () => String(Math.floor(rng() * 500)))
    .replace('{host}', () => 'node-' + (1 + Math.floor(rng() * 24)) + '.internal')
    .replace('{connstate}', () => pick(rng, CONNSTATE))
    .replace('{limitstate}', () => pick(rng, LIMITSTATE));
}

// severity distribution roughly 60/25/10/5 for info/debug... spec says 60/25/10/5.
// We map: info 60, debug 25, warn 10, error 5.
function pickSeverity(rng) {
  const r = rng();
  if (r < 0.6) return 'info';
  if (r < 0.85) return 'debug';
  if (r < 0.95) return 'warn';
  return 'error';
}

let dbInstance = null;

export async function getDb() {
  if (dbInstance) return dbInstance;
  fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });
  dbInstance = new PGlite(DATA_DIR, { extensions: { pg_trgm } });
  await dbInstance.waitReady;
  await init(dbInstance);
  return dbInstance;
}

async function init(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id      BIGINT PRIMARY KEY,
      ts      TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL,
      service  TEXT NOT NULL,
      message  TEXT NOT NULL
    );
  `);

  const res = await db.query('SELECT COUNT(*)::int AS c FROM logs;');
  const count = res.rows[0].c;

  if (count >= SEED_TARGET) {
    console.log(`[db] logs already populated (${count} rows); skipping seed.`);
    await ensureIndexes(db);
    return;
  }

  if (count > 0) {
    // Partial / inconsistent state — reset for a clean deterministic seed.
    console.log(`[db] found ${count} rows (incomplete); truncating for reseed.`);
    await db.exec('TRUNCATE TABLE logs;');
  }

  await seed(db);
  await ensureIndexes(db);
}

async function ensureIndexes(db) {
  // Ordering by ts desc (primary query shape).
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC, id DESC);');
  // Severity equality + ordering by ts.
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_sev_ts ON logs (severity, ts DESC, id DESC);');
  // Substring search: trigram index for case-insensitive ILIKE '%q%'.
  try {
    await db.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
    await db.exec(
      "CREATE INDEX IF NOT EXISTS idx_logs_msg_trgm ON logs USING gin (lower(message) gin_trgm_ops);"
    );
  } catch (e) {
    console.warn('[db] pg_trgm not available, substring search will use seq scan:', e.message);
  }
  await db.exec('ANALYZE logs;');
}

async function seed(db) {
  const t0 = Date.now();
  console.log(`[db] seeding ${SEED_TARGET} rows...`);
  const rng = mulberry32(0xc0ffee);

  // 30-day span. Newest first later via ORDER BY ts DESC.
  const startMs = Date.UTC(2024, 0, 1, 0, 0, 0);
  const spanMs = 30 * 24 * 60 * 60 * 1000;
  const stepMs = spanMs / SEED_TARGET; // roughly-even spacing, then jittered

  const BATCH = 2000;
  await db.exec('BEGIN;');
  let values = [];
  let params = [];
  let pIdx = 0;

  const flush = async () => {
    if (!values.length) return;
    const sql = `INSERT INTO logs (id, ts, severity, service, message) VALUES ${values.join(',')};`;
    await db.query(sql, params);
    values = [];
    params = [];
    pIdx = 0;
  };

  for (let i = 0; i < SEED_TARGET; i++) {
    const jitter = (rng() - 0.5) * stepMs;
    const ts = new Date(startMs + i * stepMs + jitter).toISOString();
    const severity = pickSeverity(rng);
    const service = pick(rng, SERVICES);
    const tplIndex = Math.floor(rng() * TEMPLATES.length);
    const message = buildMessage(rng, tplIndex);

    values.push(`($${pIdx + 1},$${pIdx + 2},$${pIdx + 3},$${pIdx + 4},$${pIdx + 5})`);
    params.push(i, ts, severity, service, message);
    pIdx += 5;

    if (values.length >= BATCH) {
      await flush();
    }
  }
  await flush();
  await db.exec('COMMIT;');

  console.log(`[db] seeded ${SEED_TARGET} rows in ${Date.now() - t0}ms`);
}
