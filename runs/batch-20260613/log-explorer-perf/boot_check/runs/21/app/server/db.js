import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'pgdata');

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

const TOTAL_ROWS = 100000;
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
// Distribution: ~60% debug, ~25% info, ~10% warn, ~5% error
// Cumulative: 0.60, 0.85, 0.95, 1.00
const SEV_CUMULATIVE = [0.60, 0.85, 0.95, 1.00];

const SERVICES = [
  'api-gateway',
  'auth-service',
  'user-service',
  'payment-service',
  'notification-service',
  'search-service',
  'analytics-service',
  'scheduler-service',
];

// Message templates with variable fragments.
// Selective terms: "circuit breaker", "deadlock", "out of memory"
// Non-selective terms: "request", "completed", "processing"
const MESSAGE_TEMPLATES = [
  'Processing request from client {client_id}',
  'Request completed successfully in {duration}ms',
  'Connection established to upstream host {host}',
  'Cache miss for key {cache_key}, fetching from database',
  'Cache hit for key {cache_key}, returning cached response',
  'Retrying failed operation, attempt {attempt} of 3',
  'Rate limit exceeded for client {client_id}, throttling',
  'Health check completed, all dependencies healthy',
  'Configuration reloaded from environment variables',
  'Scheduled task {task_name} started processing batch',
  'Circuit breaker triggered for downstream service {host}',
  'Deadlock detected on resource {resource_id}, retrying transaction',
  'Out of memory warning: heap usage at {heap_pct}%',
  'Request timeout after {duration}ms waiting for {host}',
  'Authentication token verified for user {user_id}',
  'Database query executed in {duration}ms, {row_count} rows returned',
  'Message published to queue {queue_name}',
  'Worker {worker_id} picked up job {job_id} from queue',
  'TLS handshake completed with {host}',
  'Graceful shutdown initiated, draining {conn_count} connections',
];

const CLIENT_IDS = ['cli-001', 'cli-002', 'cli-003', 'cli-004', 'cli-005', 'cli-100', 'cli-200', 'cli-999'];
const HOSTS = ['db-primary.internal', 'db-replica.internal', 'cache-01.internal', 'queue-01.internal', 'ext-api.example.com'];
const CACHE_KEYS = ['user:1001', 'user:2002', 'session:abc', 'config:main', 'product:555'];
const TASK_NAMES = ['cleanup', 'sync', 'report-gen', 'index-rebuild', 'backup'];
const QUEUE_NAMES = ['events', 'notifications', 'emails', 'analytics'];
const RESOURCE_IDS = ['table:orders', 'table:users', 'row:inventory:99', 'mutex:deploy'];

function pickRandom(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

function fillTemplate(template, rng) {
  return template
    .replace('{client_id}', pickRandom(CLIENT_IDS, rng))
    .replace('{duration}', String(Math.floor(rng() * 5000)))
    .replace('{host}', pickRandom(HOSTS, rng))
    .replace('{cache_key}', pickRandom(CACHE_KEYS, rng))
    .replace('{attempt}', String(Math.floor(rng() * 3) + 1))
    .replace('{task_name}', pickRandom(TASK_NAMES, rng))
    .replace('{resource_id}', pickRandom(RESOURCE_IDS, rng))
    .replace('{heap_pct}', String(Math.floor(rng() * 20 + 80)))
    .replace('{user_id}', String(Math.floor(rng() * 10000)))
    .replace('{row_count}', String(Math.floor(rng() * 1000)))
    .replace('{queue_name}', pickRandom(QUEUE_NAMES, rng))
    .replace('{worker_id}', String(Math.floor(rng() * 8)))
    .replace('{job_id}', 'job-' + String(Math.floor(rng() * 100000)))
    .replace('{conn_count}', String(Math.floor(rng() * 500)))
    .replace('{heap_pct}', String(Math.floor(rng() * 20 + 80)));
}

function generateRow(index, rng) {
  // Spread over 30 days. Start date: 2025-01-01T00:00:00Z
  const startMs = Date.UTC(2025, 0, 1, 0, 0, 0);
  const spanMs = 30 * 24 * 60 * 60 * 1000; // 30 days
  const ts = new Date(startMs + Math.floor(rng() * spanMs));

  const sevRoll = rng();
  let severity;
  for (let i = 0; i < SEV_CUMULATIVE.length; i++) {
    if (sevRoll < SEV_CUMULATIVE[i]) {
      severity = SEVERITIES[i];
      break;
    }
  }

  const service = pickRandom(SERVICES, rng);
  const template = pickRandom(MESSAGE_TEMPLATES, rng);
  const message = fillTemplate(template, rng);

  return { ts: ts.toISOString(), severity, service, message };
}

export async function initDb() {
  const db = new PGlite(DB_PATH);

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

  if (existingCount >= TOTAL_ROWS) {
    console.log(`[seed] Table already contains ${existingCount} rows, skipping seed.`);
  } else {
    if (existingCount > 0) {
      console.log(`[seed] Partial data found (${existingCount} rows), truncating and reseeding...`);
      await db.exec('TRUNCATE logs RESTART IDENTITY');
    }
    console.log(`[seed] Seeding ${TOTAL_ROWS} rows...`);
    const seedStart = Date.now();

    const rng = mulberry32(42); // Deterministic seed
    const BATCH_SIZE = 1000;

    for (let batch = 0; batch < TOTAL_ROWS / BATCH_SIZE; batch++) {
      const values = [];
      const params = [];
      for (let i = 0; i < BATCH_SIZE; i++) {
        const row = generateRow(batch * BATCH_SIZE + i, rng);
        const offset = i * 4;
        values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`);
        params.push(row.ts, row.severity, row.service, row.message);
      }
      await db.query(
        `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`,
        params
      );
      if ((batch + 1) % 10 === 0) {
        console.log(`[seed] Inserted ${(batch + 1) * BATCH_SIZE} / ${TOTAL_ROWS} rows...`);
      }
    }

    console.log(`[seed] Seeding completed in ${Date.now() - seedStart}ms`);
  }

  // Create indexes (IF NOT EXISTS is supported via checking)
  console.log('[index] Creating indexes...');
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);
  `);

  // For substring search, we use pg_trgm if available, otherwise ILIKE with the ts index
  // PGLite may not have pg_trgm, so we'll rely on optimized ILIKE with index on ts
  // Additionally create a lower(message) index for case-insensitive scanning
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops)`);
    console.log('[index] pg_trgm index created');
  } catch (e) {
    console.log('[index] pg_trgm not available, relying on sequential scan for substring queries');
  }

  console.log('[index] Indexes ready');

  // Run ANALYZE for query planner
  await db.exec('ANALYZE logs');

  return db;
}
