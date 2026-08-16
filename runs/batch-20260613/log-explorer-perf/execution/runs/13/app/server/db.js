// Embedded PGLite database: schema, deterministic seed, and indexes.
import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist to local filesystem so restarts do not reseed.
const DATA_DIR = process.env.PGLITE_DIR || path.join(__dirname, '..', '.pgdata');

export const SEVERITIES = ['debug', 'info', 'warn', 'error'];
export const SERVICES = [
  'auth-service',
  'payment-gateway',
  'user-api',
  'search-indexer',
  'notification-worker',
  'cache-proxy',
  'billing-cron',
  'media-uploader',
];

const TOTAL_ROWS = 100000;
const SEED_BATCH = 2000;
const DAYS_SPAN = 30;

// ---------------------------------------------------------------------------
// Deterministic pseudo-random generator (mulberry32). No external deps.
// ---------------------------------------------------------------------------
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

// Message templates. `{}` gets replaced with a variable fragment.
// Some fragments are highly selective (rare), others non-selective (common).
const TEMPLATES = [
  'Request completed for endpoint {} in {}ms',
  'User {} authenticated successfully',
  'Cache {} for key {}',
  'Database query on table {} took {}ms',
  'Retrying operation {} attempt {}',
  'Connection to {} established',
  'Payment {} processed for order {}',
  'Failed to reach upstream {} after {}ms',
  'Background job {} finished with status {}',
  'Rate limit {} for client {}',
  'Uploaded artifact {} size {} bytes',
  'Session {} expired for user {}',
];

// Selective fragments (rare words -> selective substring searches).
const RARE_TOKENS = [
  'quasar',
  'obsidian',
  'zephyr',
  'nebula',
  'cinnabar',
];
// Non-selective fragments (common words appear in many rows).
const COMMON_TOKENS = ['ok', 'user', 'order', 'request', 'session'];

function buildMessage(rand, i) {
  const template = TEMPLATES[Math.floor(rand() * TEMPLATES.length)];
  // Inject a rare token roughly every 400th row so a selective search
  // ("quasar") returns a small, non-zero result set.
  const injectRare = i % 400 === 0;
  let msg = template;
  msg = msg.replace(/\{\}/g, () => {
    if (injectRare) {
      return RARE_TOKENS[Math.floor(rand() * RARE_TOKENS.length)];
    }
    const pool = rand() < 0.5 ? COMMON_TOKENS : null;
    if (pool) return pool[Math.floor(rand() * pool.length)];
    return String(Math.floor(rand() * 100000));
  });
  return msg;
}

// Severity distribution ~ 60/25/10/5 for info/... actually spec: 60/25/10/5.
// We interpret as debug/info/warn/error? Spec lists severities debug/info/warn/error
// and a 60/25/10/5 split. Map the largest bucket to 'info' (most common in real logs).
// Distribution: info 60, debug 25, warn 10, error 5.
function pickSeverity(r) {
  if (r < 0.6) return 'info';
  if (r < 0.85) return 'debug';
  if (r < 0.95) return 'warn';
  return 'error';
}

let dbInstance = null;

export async function getDb() {
  if (dbInstance) return dbInstance;
  dbInstance = new PGlite(DATA_DIR);
  await dbInstance.waitReady;
  await initSchema(dbInstance);
  await maybeSeed(dbInstance);
  return dbInstance;
}

async function initSchema(db) {
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

async function tableRowCount(db) {
  const res = await db.query('SELECT COUNT(*)::int AS c FROM logs;');
  return res.rows[0].c;
}

async function maybeSeed(db) {
  const count = await tableRowCount(db);
  if (count >= TOTAL_ROWS) {
    // Already seeded on a previous boot. Ensure indexes exist and skip.
    await ensureIndexes(db);
    return;
  }
  if (count > 0) {
    // Partial / corrupt seed — start clean for determinism.
    await db.exec('TRUNCATE logs;');
  }

  const startedAt = Date.now();
  console.log('[seed] Seeding 100,000 log entries (first boot)...');

  const rand = mulberry32(1337);
  // Timestamps span 30 days ending "now-ish" but deterministic: base fixed.
  const baseMs = Date.UTC(2024, 0, 1, 0, 0, 0); // fixed epoch for determinism
  const spanMs = DAYS_SPAN * 24 * 60 * 60 * 1000;

  // Precompute row data, insert in batches.
  for (let start = 0; start < TOTAL_ROWS; start += SEED_BATCH) {
    const end = Math.min(start + SEED_BATCH, TOTAL_ROWS);
    const values = [];
    const params = [];
    let p = 0;
    for (let i = start; i < end; i++) {
      // Monotonic-ish but jittered timestamps across the span.
      const frac = i / TOTAL_ROWS;
      const jitter = (rand() - 0.5) * (spanMs / TOTAL_ROWS) * 40;
      const tsMs = baseMs + frac * spanMs + jitter;
      const ts = new Date(tsMs).toISOString();
      const severity = pickSeverity(rand());
      const service = SERVICES[Math.floor(rand() * SERVICES.length)];
      const message = buildMessage(rand, i);

      values.push(`($${++p}, $${++p}, $${++p}, $${++p}, $${++p})`);
      params.push(i + 1, ts, severity, service, message);
    }
    await db.query(
      `INSERT INTO logs (id, ts, severity, service, message) VALUES ${values.join(',')};`,
      params
    );
  }

  await ensureIndexes(db);
  console.log(`[seed] Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

async function ensureIndexes(db) {
  // Ordering index for the default (ts DESC) view and keyset pagination.
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC, id DESC);
  `);
  // Severity equality + ordering.
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_sev_ts ON logs (severity, ts DESC, id DESC);
  `);
  // Trigram-ish substring: PGlite ships pg_trgm? Not guaranteed. Use a
  // lower(message) index to speed case-insensitive prefix and help planning.
  // For substring (ILIKE '%x%') a btree can't fully serve it, but keeping
  // messages small and using a functional lower() index reduces per-row cost.
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_msg_lower ON logs (lower(message));
  `);
  await db.exec('ANALYZE logs;');
}
