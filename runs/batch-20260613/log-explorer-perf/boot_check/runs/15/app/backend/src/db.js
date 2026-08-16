import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persistent data directory so the corpus survives restarts.
const DATA_DIR = process.env.PGLITE_DIR
  ? path.resolve(process.env.PGLITE_DIR)
  : path.resolve(__dirname, '..', 'data', 'pgdata');

export const SEVERITIES = ['debug', 'info', 'warn', 'error'];
export const TOTAL_ROWS = 100_000;
const SEED_BATCH = 2_000;

// Deterministic seed configuration.
const SERVICES = [
  'auth-service',
  'payment-gateway',
  'user-api',
  'notification-worker',
  'search-indexer',
  'billing-cron',
  'media-transcoder',
  'edge-proxy',
];

// Roughly 60/25/10/5 distribution (info/debug? -> spec: 60/25/10/5).
// severity distribution: info 60, debug 25, warn 10, error 5.
const SEVERITY_DISTRIBUTION = [
  { severity: 'info', weight: 60 },
  { severity: 'debug', weight: 25 },
  { severity: 'warn', weight: 10 },
  { severity: 'error', weight: 5 },
];

// Message templates with variable fragments. Some fragments are selective
// (appear rarely), others are non-selective (appear frequently).
const MESSAGE_TEMPLATES = [
  'Request handled path=/{resource}/{id} status={status} in {ms}ms',
  'Cache {hitmiss} for key {resource}:{id}',
  'User {id} performed action {action} on {resource}',
  'Retry attempt {n} for {resource} request {id}',
  'Connection pool {resource} usage at {ms}%',
  'Background job {action} completed for batch {id}',
  'Validation {hitmiss} for payload {resource} field {action}',
  'Latency spike detected on {resource} endpoint ({ms}ms)',
];

const RESOURCES = ['orders', 'invoices', 'sessions', 'accounts', 'widgets', 'reports', 'tokens', 'uploads'];
const ACTIONS = ['create', 'update', 'delete', 'read', 'export', 'sync'];
const HITMISS = ['HIT', 'MISS'];
const STATUS = [200, 201, 204, 400, 401, 404, 500, 503];

// A deterministic 32-bit PRNG (mulberry32) so the corpus is reproducible.
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
  const total = SEVERITY_DISTRIBUTION.reduce((s, d) => s + d.weight, 0);
  let x = r * total;
  for (const d of SEVERITY_DISTRIBUTION) {
    if (x < d.weight) return d.severity;
    x -= d.weight;
  }
  return SEVERITY_DISTRIBUTION[SEVERITY_DISTRIBUTION.length - 1].severity;
}

function buildMessage(rng, i) {
  const template = MESSAGE_TEMPLATES[Math.floor(rng() * MESSAGE_TEMPLATES.length)];
  const resource = RESOURCES[Math.floor(rng() * RESOURCES.length)];
  const action = ACTIONS[Math.floor(rng() * ACTIONS.length)];
  const hitmiss = HITMISS[Math.floor(rng() * HITMISS.length)];
  const status = STATUS[Math.floor(rng() * STATUS.length)];
  const id = 1000 + Math.floor(rng() * 900000);
  const ms = 1 + Math.floor(rng() * 2000);
  const n = 1 + Math.floor(rng() * 5);

  let msg = template
    .replace('{resource}', resource)
    .replace('{action}', action)
    .replace('{hitmiss}', hitmiss)
    .replace('{status}', status)
    .replace('{id}', String(id))
    .replace('{ms}', String(ms))
    .replace('{n}', String(n));

  // Inject a rare/selective fragment on ~0.2% of rows so substring search
  // has a clearly selective term ("QUARANTINE").
  if (i % 500 === 0) {
    msg += ' [QUARANTINE]';
  }
  return msg;
}

let dbInstance = null;

export async function getDb() {
  if (dbInstance) return dbInstance;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  dbInstance = new PGlite(DATA_DIR);
  await dbInstance.waitReady;
  return dbInstance;
}

async function isSeeded(db) {
  const tbl = await db.query(
    `SELECT to_regclass('public.logs') AS reg`
  );
  if (!tbl.rows[0] || !tbl.rows[0].reg) return false;
  const res = await db.query('SELECT COUNT(*)::int AS c FROM logs');
  return res.rows[0].c >= TOTAL_ROWS;
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
  // Ordering by ts descending (primary query shape).
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_ts_id ON logs (ts DESC, id DESC);`);
  // Severity equality + ordering by ts.
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_sev_ts_id ON logs (severity, ts DESC, id DESC);`);
  // Substring/case-insensitive search over message using trigram GIN index.
  // pg_trgm accelerates ILIKE '%term%'. Fall back gracefully if unavailable.
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING gin (lower(message) gin_trgm_ops);`
    );
  } catch (err) {
    // If pg_trgm isn't bundled, we still function (ILIKE will scan);
    // seed sizes and ordering indexes keep the common paths fast.
    console.warn('pg_trgm not available, substring search will use scan:', err.message);
  }
  await db.exec(`ANALYZE logs;`);
}

async function seed(db) {
  const rng = mulberry32(0xC0FFEE);

  // 30 days ending "now-ish" but deterministic: fixed anchor timestamp.
  const startMs = Date.UTC(2024, 0, 1, 0, 0, 0); // Jan 1 2024
  const spanMs = 30 * 24 * 60 * 60 * 1000; // 30 days
  const stepMs = Math.floor(spanMs / TOTAL_ROWS); // even spread

  await db.exec('BEGIN');
  try {
    for (let start = 0; start < TOTAL_ROWS; start += SEED_BATCH) {
      const end = Math.min(start + SEED_BATCH, TOTAL_ROWS);
      const values = [];
      const params = [];
      let p = 1;
      for (let i = start; i < end; i++) {
        // ts increases with i so ordering by ts desc == newest first.
        const jitter = Math.floor(rng() * stepMs);
        const ts = new Date(startMs + i * stepMs + jitter).toISOString();
        const severity = pickWeightedSeverity(rng());
        const service = SERVICES[Math.floor(rng() * SERVICES.length)];
        const message = buildMessage(rng, i);
        values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
        params.push(i + 1, ts, severity, service, message);
      }
      await db.query(
        `INSERT INTO logs (id, ts, severity, service, message) VALUES ${values.join(',')}`,
        params
      );
    }
    await db.exec('COMMIT');
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }
}

export async function initDb() {
  const db = await getDb();
  const seeded = await isSeeded(db);
  if (seeded) {
    // Ensure indexes exist (cheap if already present).
    await createIndexes(db);
    return { db, seeded: true };
  }
  const t0 = Date.now();
  await createSchema(db);
  await seed(db);
  await createIndexes(db);
  const elapsed = Date.now() - t0;
  console.log(`Seeded ${TOTAL_ROWS} rows in ${elapsed}ms`);
  return { db, seeded: false };
}
