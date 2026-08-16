import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'pgdata');

const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SERVICES = [
  'auth-service',
  'payment-gateway',
  'user-api',
  'order-processor',
  'inventory',
  'notification',
  'search-indexer',
  'analytics',
];

// Message templates with variable fragments so substring search has
// selective and non-selective terms.
const TEMPLATES = [
  'Request handled in {n}ms for /api/{res}/{id}',
  'User {id} logged in from {ip}',
  'Cache miss for key {res}:{id}',
  'Database query took {n}ms on table {res}',
  'Connection pool exhausted, waited {n}ms',
  'Payment {id} processed for amount {n}.00 USD',
  'Retrying request to {res} (attempt {n})',
  'Rate limit exceeded for client {ip}',
  'Background job {res}-{id} completed in {n}ms',
  'Failed to acquire lock on resource {res}:{id}',
  'Health check OK, uptime {n}s',
  'Deprecated endpoint /api/{res} called by {ip}',
];

const RESOURCES = ['orders', 'users', 'items', 'sessions', 'invoices', 'carts', 'tokens', 'reports'];

// Deterministic pseudo-random generator (mulberry32) for reproducible seed.
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

function pickSeverity(r) {
  // roughly 60 / 25 / 10 / 5 distribution
  const x = r * 100;
  if (x < 60) return 'debug'; // will remap below for readability
  if (x < 85) return 'info';
  if (x < 95) return 'warn';
  return 'error';
}
// Distribution: info most common (60), debug 25, warn 10, error 5.
function severityFor(r) {
  const x = r * 100;
  if (x < 60) return 'info';
  if (x < 85) return 'debug';
  if (x < 95) return 'warn';
  return 'error';
}

const TOTAL_ROWS = 100000;
const SPAN_DAYS = 30;

let dbInstance = null;

export async function getDb() {
  if (dbInstance) return dbInstance;
  const db = new PGlite(DATA_DIR);
  await db.waitReady;
  await ensureSchema(db);
  await seedIfNeeded(db);
  dbInstance = db;
  return db;
}

async function ensureSchema(db) {
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
  // Ordering index on ts (desc ordering is main query shape).
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC, id DESC);`);
  // Severity + ordering index for severity-equality query shape.
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_sev_ts ON logs (severity, ts DESC, id DESC);`);
  // Substring search: trigram index for case-insensitive ILIKE.
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_logs_msg_trgm ON logs USING gin (lower(message) gin_trgm_ops);`
    );
  } catch (e) {
    // pg_trgm may not be available in some PGlite builds; ILIKE still works
    // (just slower). We rely on the modest corpus for the substring budget.
    console.warn('pg_trgm not available, falling back to plain ILIKE:', e.message);
  }
}

async function seedIfNeeded(db) {
  const res = await db.query(`SELECT COUNT(*)::int AS c FROM logs;`);
  const count = res.rows[0].c;
  if (count >= TOTAL_ROWS) {
    console.log(`Logs table already populated (${count} rows), skipping seed.`);
    // Ensure indexes exist (cheap if already present).
    await createIndexes(db);
    return;
  }
  if (count > 0) {
    // Partial / inconsistent state — start clean.
    await db.exec(`TRUNCATE logs;`);
  }

  console.log(`Seeding ${TOTAL_ROWS} log rows...`);
  const t0 = Date.now();

  const rand = mulberry32(0xc0ffee);
  const startMs = Date.UTC(2024, 0, 1, 0, 0, 0);
  const spanMs = SPAN_DAYS * 24 * 60 * 60 * 1000;
  const stepMs = spanMs / TOTAL_ROWS;

  const BATCH = 2000;
  for (let start = 0; start < TOTAL_ROWS; start += BATCH) {
    const end = Math.min(start + BATCH, TOTAL_ROWS);
    const values = [];
    const params = [];
    let p = 0;
    for (let i = start; i < end; i++) {
      const ts = new Date(startMs + Math.floor(i * stepMs)).toISOString();
      const severity = severityFor(rand());
      const service = SERVICES[Math.floor(rand() * SERVICES.length)];
      const tmpl = TEMPLATES[Math.floor(rand() * TEMPLATES.length)];
      const message = tmpl
        .replace('{n}', String(Math.floor(rand() * 5000)))
        .replace('{id}', String(1000 + Math.floor(rand() * 90000)))
        .replace('{res}', RESOURCES[Math.floor(rand() * RESOURCES.length)])
        .replace('{ip}', `10.${Math.floor(rand() * 256)}.${Math.floor(rand() * 256)}.${Math.floor(rand() * 256)}`);
      values.push(`($${++p},$${++p},$${++p},$${++p},$${++p})`);
      params.push(i, ts, severity, service, message);
    }
    await db.query(
      `INSERT INTO logs (id, ts, severity, service, message) VALUES ${values.join(',')};`,
      params
    );
  }

  console.log(`Seed inserted in ${Date.now() - t0}ms, building indexes...`);
  await createIndexes(db);
  await db.exec(`ANALYZE logs;`);
  console.log(`Seeding + indexing complete in ${Date.now() - t0}ms.`);
}

export { SEVERITIES };
