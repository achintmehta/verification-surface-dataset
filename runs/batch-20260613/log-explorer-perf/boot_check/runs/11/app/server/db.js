import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persistent on-disk PGLite database directory (survives restarts).
const DATA_DIR = path.join(__dirname, '..', 'pgdata');

const SERVICES = [
  'auth-service',
  'payment-gateway',
  'user-api',
  'search-indexer',
  'notification-worker',
  'cdn-edge',
  'billing-cron',
  'analytics-pipeline',
];

// Severity distribution buckets (~60/25/10/5) resolved deterministically per-row.
// info 60, warn 25, error 10, debug 5
const SEVERITY_BUCKETS = [
  { sev: 'info', upto: 60 },
  { sev: 'warn', upto: 85 },
  { sev: 'error', upto: 95 },
  { sev: 'debug', upto: 100 },
];

// Message templates with variable fragments. Some fragments are selective
// (rare) and some are non-selective (common), so substring search has both.
const TEMPLATES = [
  'Request handled for user_{uid} in {ms}ms',
  'Cache miss for key session:{uid}',
  'Connection pool exhausted, retrying attempt {n}',
  'Payment charge {cid} authorized for account {uid}',
  'Latency spike detected: {ms}ms on shard {n}',
  'Background job {cid} completed successfully',
  'Rate limit exceeded for client {uid}',
  'Failed to reach upstream host node-{n}',
  'Reindexed {n} documents for tenant {uid}',
  'Token validation succeeded for principal {uid}',
  'Disk usage crossed threshold on volume vol-{n}',
  'Notification dispatched to device {cid}',
];

const SEVERITY_SET = new Set(['debug', 'info', 'warn', 'error']);

// Deterministic PRNG (mulberry32) so the corpus is identical on every seed.
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
const BATCH_SIZE = 2000;
// 30 day span, ending "now" at a fixed anchor for determinism.
const SPAN_MS = 30 * 24 * 60 * 60 * 1000;
const ANCHOR_MS = Date.UTC(2024, 0, 31, 0, 0, 0); // 2024-01-31T00:00:00Z

function pickSeverity(pct) {
  for (const b of SEVERITY_BUCKETS) {
    if (pct < b.upto) return b.sev;
  }
  return 'debug';
}

function buildMessage(rng) {
  const tpl = TEMPLATES[Math.floor(rng() * TEMPLATES.length)];
  const uid = Math.floor(rng() * 5000);
  const cid = 'txn-' + Math.floor(rng() * 100000).toString(36);
  const ms = Math.floor(rng() * 4000);
  const n = Math.floor(rng() * 64);
  return tpl
    .replace('{uid}', String(uid))
    .replace('{cid}', cid)
    .replace('{ms}', String(ms))
    .replace('{n}', String(n));
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
  // Handle schema evolution: if an older `logs` table exists without the
  // message_lc column, drop it so the current schema + deterministic seed
  // are rebuilt cleanly.
  const exists = await db.query(
    `SELECT to_regclass('public.logs') IS NOT NULL AS present;`
  );
  if (exists.rows[0].present) {
    const col = await db.query(
      `SELECT COUNT(*)::int AS c FROM information_schema.columns
       WHERE table_name = 'logs' AND column_name = 'message_lc';`
    );
    if (col.rows[0].c === 0) {
      console.log('[db] legacy schema detected (no message_lc), rebuilding table.');
      await db.exec('DROP TABLE logs;');
    }
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id         BIGINT PRIMARY KEY,
      ts         TIMESTAMPTZ NOT NULL,
      severity   TEXT NOT NULL,
      service    TEXT NOT NULL,
      message    TEXT NOT NULL,
      message_lc TEXT NOT NULL
    );
  `);

  // Ordering index (ts desc, id desc for a stable tiebreak).
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC, id DESC);`);
  // Severity equality + ordering.
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_sev_ts ON logs (severity, ts DESC, id DESC);`);
  // Substring search strategy: prefer a trigram GIN index over a precomputed
  // lowercase column so case-insensitive LIKE '%term%' is index-accelerated.
  // If pg_trgm is unavailable in this PGLite build, we fall back to a plain
  // sequential LIKE scan on the precomputed lowercase column (no per-row
  // lower() recomputation), which remains within budget at 100k short rows.
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_logs_msg_trgm ON logs USING gin (message_lc gin_trgm_ops);`
    );
    console.log('[db] pg_trgm trigram index enabled for substring search.');
  } catch (e) {
    console.warn(
      '[db] pg_trgm unavailable; substring search uses scan on precomputed message_lc column:',
      e.message
    );
  }
}

async function seedIfNeeded(db) {
  const res = await db.query('SELECT COUNT(*)::int AS c FROM logs;');
  const count = res.rows[0].c;
  if (count >= TOTAL_ROWS) {
    console.log(`[db] logs already seeded (${count} rows), skipping seed.`);
    return;
  }
  if (count > 0) {
    // Partial/incomplete seed: reset for a clean deterministic corpus.
    console.log(`[db] partial seed detected (${count} rows), resetting.`);
    await db.exec('TRUNCATE logs;');
  }

  console.log('[db] seeding 100,000 log rows...');
  const t0 = Date.now();
  const rng = mulberry32(0x1234abcd);

  // Precompute timestamps as strictly increasing across the corpus so that
  // ordering by ts descending yields id descending overall (id 0 is oldest).
  // We insert in batches with a multi-row VALUES statement.
  let inserted = 0;
  while (inserted < TOTAL_ROWS) {
    const batchEnd = Math.min(inserted + BATCH_SIZE, TOTAL_ROWS);
    const values = [];
    const params = [];
    let p = 0;
    for (let i = inserted; i < batchEnd; i++) {
      const sevPct = Math.floor(rng() * 100);
      const severity = pickSeverity(sevPct);
      const service = SERVICES[Math.floor(rng() * SERVICES.length)];
      const message = buildMessage(rng);
      // Evenly spread timestamps across the 30-day span, id ascending in time.
      const tsMs = ANCHOR_MS - SPAN_MS + Math.floor((i / TOTAL_ROWS) * SPAN_MS);
      const ts = new Date(tsMs).toISOString();
      values.push(
        `($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6})`
      );
      params.push(i, ts, severity, service, message, message.toLowerCase());
      p += 6;
    }
    await db.query(
      `INSERT INTO logs (id, ts, severity, service, message, message_lc) VALUES ${values.join(',')};`,
      params
    );
    inserted = batchEnd;
  }

  // Ensure statistics/planner are up to date for index usage.
  await db.exec('ANALYZE logs;');
  console.log(`[db] seed complete: ${inserted} rows in ${Date.now() - t0}ms.`);
}

export { SEVERITY_SET };
