import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'pgdata');

let db = null;

export function getDB() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

// Deterministic pseudo-random number generator (mulberry32)
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function initDB() {
  console.log('Initializing PGLite database...');
  db = new PGlite(DB_PATH);

  // Create table if not exists
  await db.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity VARCHAR(5) NOT NULL,
      service VARCHAR(50) NOT NULL,
      message TEXT NOT NULL
    )
  `);

  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*)::int AS cnt FROM logs');
  const existingCount = countResult.rows[0].cnt;

  if (existingCount >= 100000) {
    console.log(`Database already seeded with ${existingCount} rows, skipping seed.`);
    // Ensure indexes exist
    await createIndexes();
    return;
  }

  if (existingCount > 0 && existingCount < 100000) {
    console.log(`Partial seed detected (${existingCount} rows), clearing and reseeding...`);
    await db.query('DELETE FROM logs');
  }

  console.log('Seeding 100,000 log entries...');
  console.time('seed');
  await seedLogs();
  console.timeEnd('seed');

  console.log('Creating indexes...');
  console.time('indexes');
  await createIndexes();
  console.timeEnd('indexes');
}

async function createIndexes() {
  // Index for ordering by ts (descending scans)
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_ts_desc ON logs (ts DESC, id DESC)');
  // Index for severity + ts ordering  
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC, id DESC)');
  // pg_trgm extension for ILIKE - try to create, fallback to btree on message
  // PGLite may not support pg_trgm, so we'll rely on the severity+ts index and sequential scan for text search
  // For better ILIKE performance, let's also add a simple index
  // Actually, for ILIKE with leading wildcard, no btree index helps. We'll accept seq scan for text search
  // but the severity index will help when combined with severity filter.
}

async function seedLogs() {
  const rng = mulberry32(42); // Deterministic seed

  const TOTAL = 100000;
  const BATCH_SIZE = 1000;

  const services = [
    'api-gateway',
    'auth-service',
    'user-service',
    'payment-service',
    'notification-service',
    'search-service',
    'analytics-service',
    'file-service'
  ];

  // Severity distribution: debug 60%, info 25%, warn 10%, error 5%
  const severityThresholds = [
    { severity: 'debug', threshold: 0.60 },
    { severity: 'info', threshold: 0.85 },
    { severity: 'warn', threshold: 0.95 },
    { severity: 'error', threshold: 1.00 }
  ];

  // Message templates with variable fragments
  // Some terms will be selective (rare), some non-selective (common)
  const messageTemplates = [
    // Common patterns (non-selective terms like "request", "response", "processing")
    (rng, svc) => `Processing request for ${svc} endpoint /${randomEndpoint(rng)}`,
    (rng, svc) => `Response sent with status ${randomStatus(rng)} in ${Math.floor(rng() * 500)}ms`,
    (rng, svc) => `Database query completed in ${Math.floor(rng() * 200)}ms for table ${randomTable(rng)}`,
    (rng, svc) => `Cache ${rng() > 0.5 ? 'hit' : 'miss'} for key ${randomCacheKey(rng)}`,
    (rng, svc) => `Health check passed for ${svc} - uptime ${Math.floor(rng() * 86400)}s`,
    (rng, svc) => `Connection pool stats: active=${Math.floor(rng() * 20)}, idle=${Math.floor(rng() * 10)}`,
    (rng, svc) => `Request validation ${rng() > 0.3 ? 'passed' : 'failed'} for ${randomEndpoint(rng)}`,
    (rng, svc) => `Middleware ${randomMiddleware(rng)} executed in ${Math.floor(rng() * 50)}ms`,
    // Selective patterns (rare terms like "circuit-breaker", "deadlock", "OOM")
    (rng, svc) => `Circuit-breaker tripped for ${svc}: ${Math.floor(rng() * 100)}% failure rate`,
    (rng, svc) => `Deadlock detected in transaction ${randomTxId(rng)} on table ${randomTable(rng)}`,
    (rng, svc) => `OOM warning: heap usage at ${80 + Math.floor(rng() * 20)}% for ${svc}`,
    (rng, svc) => `Rate limit exceeded for client ${randomClientId(rng)}: ${Math.floor(rng() * 1000)} req/s`,
    (rng, svc) => `SSL certificate renewal scheduled for ${svc} in ${Math.floor(rng() * 30)} days`,
    (rng, svc) => `Graceful shutdown initiated for ${svc} worker ${Math.floor(rng() * 8)}`,
    (rng, svc) => `Retry attempt ${Math.floor(rng() * 5) + 1}/5 for downstream call to ${randomEndpoint(rng)}`,
    (rng, svc) => `Latency spike detected: p99=${Math.floor(rng() * 5000)}ms for ${randomEndpoint(rng)}`,
  ];

  function randomEndpoint(rng) {
    const endpoints = ['users', 'orders', 'products', 'payments', 'sessions', 'profiles', 'notifications', 'search', 'analytics', 'files'];
    return endpoints[Math.floor(rng() * endpoints.length)];
  }

  function randomStatus(rng) {
    const statuses = [200, 200, 200, 201, 204, 301, 400, 401, 403, 404, 500, 502, 503];
    return statuses[Math.floor(rng() * statuses.length)];
  }

  function randomTable(rng) {
    const tables = ['users', 'orders', 'sessions', 'products', 'payments', 'audit_log', 'metrics'];
    return tables[Math.floor(rng() * tables.length)];
  }

  function randomCacheKey(rng) {
    const prefixes = ['user', 'session', 'config', 'feature', 'rate'];
    return `${prefixes[Math.floor(rng() * prefixes.length)]}:${Math.floor(rng() * 10000)}`;
  }

  function randomMiddleware(rng) {
    const mws = ['auth', 'cors', 'rate-limit', 'compression', 'logging', 'validation'];
    return mws[Math.floor(rng() * mws.length)];
  }

  function randomTxId(rng) {
    const chars = '0123456789abcdef';
    let s = '';
    for (let i = 0; i < 8; i++) s += chars[Math.floor(rng() * chars.length)];
    return s;
  }

  function randomClientId(rng) {
    return `client-${Math.floor(rng() * 500)}`;
  }

  // Base timestamp: 30 days ago from a fixed point (2025-01-15T00:00:00Z for determinism)
  const baseTs = new Date('2025-01-15T00:00:00Z').getTime();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  for (let batch = 0; batch < TOTAL / BATCH_SIZE; batch++) {
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (let i = 0; i < BATCH_SIZE; i++) {
      const rowNum = batch * BATCH_SIZE + i;

      // Deterministic timestamp spread over 30 days
      const tsOffset = (rowNum / TOTAL) * thirtyDaysMs + rng() * (thirtyDaysMs / TOTAL);
      const ts = new Date(baseTs + tsOffset);

      // Severity based on distribution
      const sevRoll = rng();
      let severity = 'debug';
      for (const st of severityThresholds) {
        if (sevRoll < st.threshold) {
          severity = st.severity;
          break;
        }
      }

      // Service
      const service = services[Math.floor(rng() * services.length)];

      // Message - weight towards common templates (first 8) more heavily
      const templateIdx = rng() < 0.7
        ? Math.floor(rng() * 8)         // 70% common templates (0-7)
        : 8 + Math.floor(rng() * 8);     // 30% selective templates (8-15)
      const message = messageTemplates[templateIdx](rng, service);

      values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
      params.push(ts.toISOString(), severity, service, message);
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`;
    await db.query(sql, params);

    if ((batch + 1) % 10 === 0) {
      console.log(`  Seeded ${(batch + 1) * BATCH_SIZE} / ${TOTAL} rows`);
    }
  }

  // Verify count
  const verifyResult = await db.query('SELECT COUNT(*)::int AS cnt FROM logs');
  console.log(`Seed complete. Total rows: ${verifyResult.rows[0].cnt}`);
}
