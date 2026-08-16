import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'pgdata');

let db;

// Simple seeded PRNG (mulberry32) for deterministic data generation
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
  console.time('db-init');
  db = new PGlite(DB_PATH);

  // Create table if not exists
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL,
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);

  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*)::int AS cnt FROM logs');
  const existingCount = countResult.rows[0].cnt;

  if (existingCount >= 100000) {
    console.log(`Database already seeded with ${existingCount} rows. Skipping seed.`);
    // Ensure indexes exist (idempotent)
    await ensureIndexes();
    console.timeEnd('db-init');
    return db;
  }

  if (existingCount > 0 && existingCount < 100000) {
    // Partial seed — truncate and re-seed
    console.log(`Found ${existingCount} rows (partial seed). Truncating and re-seeding...`);
    await db.exec('TRUNCATE logs RESTART IDENTITY');
  }

  console.log('Seeding 100,000 log entries...');
  console.time('seed');
  await seedLogs();
  console.timeEnd('seed');

  console.log('Creating indexes...');
  console.time('indexes');
  await ensureIndexes();
  console.timeEnd('indexes');

  console.timeEnd('db-init');
  return db;
}

async function ensureIndexes() {
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING btree (lower(message) text_pattern_ops);
  `);
}

async function seedLogs() {
  const TOTAL = 100000;
  const BATCH_SIZE = 2000;

  const rand = mulberry32(42);

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

  // Severity distribution: debug ~60%, info ~25%, warn ~10%, error ~5%
  const severityThresholds = [
    { threshold: 0.60, severity: 'debug' },
    { threshold: 0.85, severity: 'info' },
    { threshold: 0.95, severity: 'warn' },
    { threshold: 1.00, severity: 'error' }
  ];

  // Message templates with variable fragments
  // Some terms are selective (rare), some are non-selective (common)
  const messageTemplates = [
    // Common/non-selective patterns
    (r, svc) => `Processing request for ${svc} endpoint ${['GET /api/users', 'POST /api/login', 'GET /api/items', 'PUT /api/settings'][Math.floor(r() * 4)]}`,
    (r, svc) => `Database query completed in ${Math.floor(r() * 500)}ms for ${svc}`,
    (r, svc) => `Cache ${r() > 0.5 ? 'hit' : 'miss'} for key ${svc}:session:${Math.floor(r() * 10000)}`,
    (r, svc) => `Health check passed for ${svc} with status ${r() > 0.1 ? 'healthy' : 'degraded'}`,
    (r, svc) => `Request handled successfully by ${svc} in ${Math.floor(r() * 200)}ms`,
    (r, svc) => `Connection pool stats for ${svc}: active=${Math.floor(r() * 20)} idle=${Math.floor(r() * 10)}`,
    (r, svc) => `Received ${['webhook', 'callback', 'notification', 'event'][Math.floor(r() * 4)]} from upstream service`,
    (r, svc) => `Starting background task ${['cleanup', 'sync', 'backup', 'refresh'][Math.floor(r() * 4)]} for ${svc}`,
    // Selective patterns (rarer terms)
    (r, svc) => `OutOfMemoryError: heap space exhausted in ${svc} worker ${Math.floor(r() * 8)}`,
    (r, svc) => `CircuitBreaker tripped for ${svc} after ${Math.floor(r() * 5) + 3} consecutive failures`,
    (r, svc) => `TLS handshake failed: certificate expired for ${svc} upstream connection`,
    (r, svc) => `RateLimiter throttled client ${Math.floor(r() * 1000)} on ${svc}: ${Math.floor(r() * 100) + 100} req/s exceeded`,
    (r, svc) => `Deadlock detected in ${svc} transaction ${Math.floor(r() * 99999)}, retrying`,
    (r, svc) => `Graceful shutdown initiated for ${svc} instance ${Math.floor(r() * 16)}`,
    (r, svc) => `Schema migration ${['v2.1.0', 'v2.2.0', 'v3.0.0'][Math.floor(r() * 3)]} applied to ${svc} database`,
    (r, svc) => `Partial replication lag detected: ${svc} replica ${Math.floor(r() * 500) + 100}ms behind primary`,
  ];

  // 30 days span
  const endDate = new Date('2025-01-15T00:00:00Z');
  const startDate = new Date('2024-12-16T00:00:00Z');
  const timeRange = endDate.getTime() - startDate.getTime();

  // Pre-generate all rows in memory, then batch insert
  const allRows = [];
  for (let i = 0; i < TOTAL; i++) {
    const r1 = rand();
    let severity = 'debug';
    for (const st of severityThresholds) {
      if (r1 <= st.threshold) {
        severity = st.severity;
        break;
      }
    }

    const service = services[Math.floor(rand() * services.length)];
    const ts = new Date(startDate.getTime() + rand() * timeRange);

    // Select message template — weight toward common ones
    const templateIdx = rand() < 0.75
      ? Math.floor(rand() * 8)       // common templates (0-7)
      : 8 + Math.floor(rand() * 8);  // selective templates (8-15)
    const message = messageTemplates[templateIdx](rand, service);

    allRows.push({ ts, severity, service, message });
  }

  // Batch insert using multi-value INSERT statements
  for (let batchStart = 0; batchStart < TOTAL; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL);
    const batchRows = allRows.slice(batchStart, batchEnd);

    const valuePlaceholders = [];
    const params = [];
    for (let i = 0; i < batchRows.length; i++) {
      const row = batchRows[i];
      const base = i * 4;
      valuePlaceholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
      params.push(row.ts.toISOString(), row.severity, row.service, row.message);
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${valuePlaceholders.join(', ')}`;
    await db.query(sql, params);

    if ((batchStart + BATCH_SIZE) % 20000 === 0 || batchEnd === TOTAL) {
      console.log(`  Seeded ${batchEnd}/${TOTAL} rows`);
    }
  }
}

export function getDB() {
  if (!db) throw new Error('Database not initialized');
  return db;
}
