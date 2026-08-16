/**
 * PGLite database initialization, schema creation, seeding, and indexing.
 *
 * Design notes:
 * - PGLite is embedded Postgres running in Node via WASM; data persists to ./data/pglite
 * - We detect an already-seeded table by checking COUNT(*); if 100k rows exist we skip seeding
 * - Batch inserts use multi-row VALUE lists (1000 rows per statement) to stay fast
 * - Indexes:
 *     idx_logs_ts          – covers ORDER BY ts DESC for unfiltered queries
 *     idx_logs_severity_ts – covers WHERE severity = ? ORDER BY ts DESC
 *     idx_logs_message_trgm– pg_trgm GIN index for ILIKE substring search
 *   pg_trgm is bundled with PGLite's contrib extensions
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, '..', 'data', 'pglite');

const TOTAL_ROWS = 100_000;
const BATCH_SIZE = 1_000;

// ── Deterministic pseudo-random number generator (mulberry32) ──────────────
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Corpus parameters ──────────────────────────────────────────────────────
const SERVICES = [
  'auth-service',
  'api-gateway',
  'user-service',
  'payment-service',
  'notification-service',
  'search-service',
  'analytics-service',
  'storage-service',
];

const SEVERITIES = ['debug', 'info', 'warn', 'error'];
// Cumulative probability thresholds: ~60% debug, 25% info, 10% warn, 5% error
const SEV_THRESHOLDS = [0.60, 0.85, 0.95, 1.00];

// Message templates – designed so some terms are selective (rare) and others
// are non-selective (common), enabling meaningful substring search tests.
const TEMPLATES = [
  // debug (0-7)
  (r) => `Handling request ${r.reqId} from ${r.ip} on route ${r.route}`,
  (r) => `Cache ${r.cacheOp} for key ${r.cacheKey} in ${r.ms}ms`,
  (r) => `DB query executed in ${r.ms}ms: SELECT * FROM ${r.table} WHERE id=${r.id}`,
  (r) => `Session ${r.sessionId} refreshed for user ${r.userId}`,
  (r) => `Config reload triggered by signal ${r.signal}`,
  (r) => `Heartbeat ping from ${r.host} latency=${r.ms}ms`,
  (r) => `Parsed ${r.count} items from queue batch ${r.batchId}`,
  (r) => `Dependency check passed for module ${r.module}`,
  // info (8-15)
  (r) => `User ${r.userId} logged in successfully from ${r.ip}`,
  (r) => `Payment ${r.paymentId} processed for amount ${r.amount} USD`,
  (r) => `File ${r.filename} uploaded to bucket ${r.bucket}`,
  (r) => `Search query "${r.query}" returned ${r.count} results in ${r.ms}ms`,
  (r) => `Notification ${r.notifId} dispatched via ${r.channel} to user ${r.userId}`,
  (r) => `Service ${r.service} started on port ${r.port}`,
  (r) => `Scheduled job ${r.jobName} completed in ${r.ms}ms`,
  (r) => `API rate limit: user ${r.userId} at ${r.count}/${r.limit} requests`,
  // warn (16-20)
  (r) => `Slow query detected (${r.ms}ms): SELECT * FROM ${r.table}`,
  (r) => `Retry attempt ${r.attempt} for request ${r.reqId} to ${r.host}`,
  (r) => `Memory usage at ${r.pct}% on host ${r.host}`,
  (r) => `Deprecated endpoint ${r.route} called by user ${r.userId}`,
  (r) => `Connection pool exhausted for ${r.service}, queuing request`,
  // error (21-24)
  (r) => `Unhandled exception in ${r.module}: ${r.errMsg}`,
  (r) => `Payment ${r.paymentId} FAILED: ${r.errMsg}`,
  (r) => `Authentication failure for user ${r.userId} from ${r.ip}: invalid token`,
  (r) => `Database connection lost to ${r.host}: ${r.errMsg}`,
];

const ERROR_MESSAGES = [
  'NullPointerException at line 42',
  'Connection timeout after 30000ms',
  'Invalid JWT signature',
  'Disk quota exceeded',
  'Out of memory: kill process',
  'SSL handshake failed',
  'Deadlock detected in transaction',
  'Schema validation failed',
];

const ROUTES   = ['/api/users', '/api/payments', '/api/search', '/api/files',
                  '/api/notifications', '/api/auth/login', '/api/auth/logout', '/health'];
const TABLES   = ['users', 'payments', 'sessions', 'notifications', 'files', 'audit_log'];
const CHANNELS = ['email', 'sms', 'push', 'webhook'];
const CACHE_OPS = ['hit', 'miss', 'evict', 'set'];
const JOB_NAMES = ['cleanup-sessions', 'send-digests', 'reindex-search', 'archive-logs', 'sync-payments'];
const MODULES  = ['auth', 'payment', 'storage', 'search', 'notification', 'analytics'];
const SIGNALS  = ['SIGHUP', 'SIGUSR1', 'SIGUSR2'];

function generateRow(rand) {
  const sevRoll = rand();
  let sevIdx = 0;
  for (let s = 0; s < SEV_THRESHOLDS.length; s++) {
    if (sevRoll < SEV_THRESHOLDS[s]) { sevIdx = s; break; }
  }
  const severity = SEVERITIES[sevIdx];

  // Pick template weighted toward severity bucket
  let templateIdx;
  if      (sevIdx === 0) templateIdx = Math.floor(rand() * 8);
  else if (sevIdx === 1) templateIdx = 8  + Math.floor(rand() * 8);
  else if (sevIdx === 2) templateIdx = 16 + Math.floor(rand() * 5);
  else                   templateIdx = 21 + Math.floor(rand() * 4);

  const r = {
    reqId:     `req-${(rand() * 0xffffffff >>> 0).toString(16).padStart(8, '0')}`,
    ip:        `10.${rand() * 255 | 0}.${rand() * 255 | 0}.${rand() * 255 | 0}`,
    route:     ROUTES[rand() * ROUTES.length | 0],
    cacheOp:   CACHE_OPS[rand() * CACHE_OPS.length | 0],
    cacheKey:  `key:${rand() * 1000000 | 0}`,
    ms:        (rand() * 2000 | 0) + 1,
    table:     TABLES[rand() * TABLES.length | 0],
    id:        rand() * 1000000 | 0,
    sessionId: `sess-${(rand() * 0xffffffff >>> 0).toString(16).padStart(8, '0')}`,
    userId:    `user-${rand() * 10000 | 0}`,
    signal:    SIGNALS[rand() * SIGNALS.length | 0],
    host:      `host-${rand() * 20 | 0}.internal`,
    count:     rand() * 500 | 0,
    batchId:   `batch-${rand() * 1000 | 0}`,
    module:    MODULES[rand() * MODULES.length | 0],
    paymentId: `pay-${(rand() * 0xffffffff >>> 0).toString(16).padStart(8, '0')}`,
    amount:    ((rand() * 9999) + 1).toFixed(2),
    filename:  `file-${rand() * 1000000 | 0}.dat`,
    bucket:    `bucket-${rand() * 5 | 0}`,
    query:     `search term ${rand() * 100 | 0}`,
    notifId:   `notif-${rand() * 1000000 | 0}`,
    channel:   CHANNELS[rand() * CHANNELS.length | 0],
    service:   SERVICES[rand() * SERVICES.length | 0],
    port:      3000 + (rand() * 100 | 0),
    jobName:   JOB_NAMES[rand() * JOB_NAMES.length | 0],
    limit:     100 + (rand() * 900 | 0),
    pct:       rand() * 100 | 0,
    attempt:   (rand() * 5 | 0) + 1,
    errMsg:    ERROR_MESSAGES[rand() * ERROR_MESSAGES.length | 0],
  };

  const message = TEMPLATES[templateIdx](r);
  const service = SERVICES[rand() * SERVICES.length | 0];

  return { severity, service, message };
}

// ── SQL string escaping ────────────────────────────────────────────────────
function sqlStr(s) {
  // Escape single quotes by doubling them (standard SQL)
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// ── Main export ────────────────────────────────────────────────────────────
let _db = null;

export async function getDb() {
  if (_db) return _db;

  console.log('[db] Opening PGLite at', DATA_DIR);
  const db = new PGlite(DATA_DIR);
  await db.waitReady;

  // Enable pg_trgm for ILIKE acceleration
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    console.log('[db] pg_trgm extension ready');
  } catch (e) {
    console.warn('[db] pg_trgm not available, ILIKE will use sequential scan:', e.message);
  }

  // Create table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id        BIGSERIAL    PRIMARY KEY,
      ts        TIMESTAMPTZ  NOT NULL,
      severity  TEXT         NOT NULL,
      service   TEXT         NOT NULL,
      message   TEXT         NOT NULL
    );
  `);

  // Create indexes
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts
      ON logs (ts DESC);
  `);
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts
      ON logs (severity, ts DESC);
  `);
  try {
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_message_trgm
        ON logs USING GIN (message gin_trgm_ops);
    `);
    console.log('[db] GIN trgm index ready');
  } catch (e) {
    console.warn('[db] Could not create trgm index:', e.message);
  }

  // Check if already seeded
  const countRes = await db.query(`SELECT COUNT(*) AS n FROM logs;`);
  const existingCount = parseInt(countRes.rows[0].n, 10);

  if (existingCount >= TOTAL_ROWS) {
    console.log(`[db] Already seeded (${existingCount} rows). Skipping seed.`);
  } else {
    if (existingCount > 0) {
      console.log(`[db] Partial seed detected (${existingCount} rows). Truncating and reseeding…`);
      await db.exec(`TRUNCATE TABLE logs RESTART IDENTITY;`);
    }
    console.log(`[db] Seeding ${TOTAL_ROWS} rows…`);
    const t0 = Date.now();
    await seed(db);
    console.log(`[db] Seeding complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  _db = db;
  return db;
}

async function seed(db) {
  const rand = mulberry32(0xdeadbeef);

  // Spread 100k rows over 30 days ending at a fixed epoch for determinism
  const END_TS   = new Date('2024-01-31T23:59:59.000Z').getTime();
  const START_TS = END_TS - 30 * 24 * 60 * 60 * 1000;
  const SPAN     = END_TS - START_TS;

  let inserted = 0;

  while (inserted < TOTAL_ROWS) {
    const batchEnd = Math.min(inserted + BATCH_SIZE, TOTAL_ROWS);
    const valueParts = [];

    for (let i = inserted; i < batchEnd; i++) {
      const { severity, service, message } = generateRow(rand);
      // Deterministic timestamp: uniformly distributed across the 30-day window
      const tsMs = START_TS + Math.floor((i / TOTAL_ROWS) * SPAN);
      const ts   = new Date(tsMs).toISOString();
      valueParts.push(
        `(${sqlStr(ts)}, ${sqlStr(severity)}, ${sqlStr(service)}, ${sqlStr(message)})`
      );
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${valueParts.join(',')};`;
    await db.exec(sql);

    inserted = batchEnd;
    if (inserted % 10_000 === 0 || inserted === TOTAL_ROWS) {
      console.log(`[db]   … ${inserted}/${TOTAL_ROWS} rows inserted`);
    }
  }
}
