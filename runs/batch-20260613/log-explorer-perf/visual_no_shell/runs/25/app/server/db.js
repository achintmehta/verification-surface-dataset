const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'pgdata');
const TOTAL_ROWS = 100_000;
const BATCH_SIZE = 2000;

// Deterministic PRNG (mulberry32)
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SERVICES = [
  'api-gateway',
  'auth-service',
  'user-service',
  'order-service',
  'payment-service',
  'notification-service',
  'inventory-service',
  'analytics-service'
];

// Distribution: debug 60%, info 25%, warn 10%, error 5%
const SEVERITY_THRESHOLDS = [
  { threshold: 0.60, level: 'debug' },
  { threshold: 0.85, level: 'info' },
  { threshold: 0.95, level: 'warn' },
  { threshold: 1.00, level: 'error' }
];

// Message templates with variable fragments
// Some terms are selective (rare), some are non-selective (common)
const MESSAGE_TEMPLATES = [
  // Non-selective: "request", "response", "processing" appear very often
  'Processing incoming request from client {clientId}',
  'Response sent to client {clientId} with status {status}',
  'Request completed in {duration}ms',
  'Handling request for endpoint {endpoint}',
  'Processing batch operation for {count} items',
  // Moderately selective
  'Cache miss for key user:{userId}',
  'Cache hit for key session:{sessionId}',
  'Database query executed in {duration}ms',
  'Connection pool stats: active={active}, idle={idle}',
  'Rate limit check for IP {ip}',
  // Selective: "timeout", "failure", "circuit-breaker" are rare
  'Connection timeout after {duration}ms to {host}',
  'Authentication failure for user {userId}: invalid credentials',
  'Circuit-breaker tripped for service {service}',
  'Memory usage alert: heap={heapMB}MB, rss={rssMB}MB',
  'Retry attempt {attempt} of {maxRetries} for operation {opId}',
  // Very selective
  'FATAL: Unhandled exception in worker {workerId}: {error}',
  'Disk space critical: {percent}% used on volume {volume}',
  'SSL certificate expiring in {days} days for domain {domain}',
  'Deadlock detected between transactions {txId1} and {txId2}',
  'Data corruption detected in block {blockId} of table {table}'
];

const CLIENT_IDS = ['client-alpha', 'client-beta', 'client-gamma', 'client-delta', 'client-epsilon'];
const STATUSES = ['200', '201', '204', '301', '400', '401', '403', '404', '500', '502', '503'];
const ENDPOINTS = ['/api/users', '/api/orders', '/api/products', '/api/auth/login', '/api/payments', '/api/health', '/api/metrics'];
const HOSTS = ['db-primary.internal', 'db-replica.internal', 'cache-01.internal', 'queue.internal'];
const ERRORS = ['NullPointerException', 'OutOfMemoryError', 'StackOverflowError', 'TimeoutException'];
const DOMAINS = ['api.example.com', 'auth.example.com', 'cdn.example.com'];
const VOLUMES = ['/dev/sda1', '/dev/sdb1', '/dev/nvme0n1'];

function pickFrom(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

function generateMessage(templateIdx, rng) {
  let msg = MESSAGE_TEMPLATES[templateIdx];
  msg = msg.replace('{clientId}', pickFrom(CLIENT_IDS, rng));
  msg = msg.replace('{status}', pickFrom(STATUSES, rng));
  msg = msg.replace('{duration}', String(Math.floor(rng() * 5000)));
  msg = msg.replace('{endpoint}', pickFrom(ENDPOINTS, rng));
  msg = msg.replace('{count}', String(Math.floor(rng() * 1000) + 1));
  msg = msg.replace('{userId}', String(Math.floor(rng() * 10000)));
  msg = msg.replace('{sessionId}', String(Math.floor(rng() * 100000)));
  msg = msg.replace('{active}', String(Math.floor(rng() * 50)));
  msg = msg.replace('{idle}', String(Math.floor(rng() * 50)));
  msg = msg.replace('{ip}', `192.168.${Math.floor(rng() * 256)}.${Math.floor(rng() * 256)}`);
  msg = msg.replace('{host}', pickFrom(HOSTS, rng));
  msg = msg.replace('{service}', pickFrom(SERVICES, rng));
  msg = msg.replace('{heapMB}', String(Math.floor(rng() * 2048)));
  msg = msg.replace('{rssMB}', String(Math.floor(rng() * 4096)));
  msg = msg.replace('{attempt}', String(Math.floor(rng() * 5) + 1));
  msg = msg.replace('{maxRetries}', '5');
  msg = msg.replace('{opId}', `op-${Math.floor(rng() * 99999)}`);
  msg = msg.replace('{workerId}', String(Math.floor(rng() * 16)));
  msg = msg.replace('{error}', pickFrom(ERRORS, rng));
  msg = msg.replace('{percent}', String(Math.floor(rng() * 15) + 85));
  msg = msg.replace('{volume}', pickFrom(VOLUMES, rng));
  msg = msg.replace('{days}', String(Math.floor(rng() * 30) + 1));
  msg = msg.replace('{domain}', pickFrom(DOMAINS, rng));
  msg = msg.replace('{txId1}', `tx-${Math.floor(rng() * 99999)}`);
  msg = msg.replace('{txId2}', `tx-${Math.floor(rng() * 99999)}`);
  msg = msg.replace('{blockId}', String(Math.floor(rng() * 10000)));
  msg = msg.replace('{table}', pickFrom(['users', 'orders', 'products', 'sessions'], rng));
  return msg;
}

function generateRow(index, rng) {
  // Span 30 days, going backward from a fixed reference point
  const BASE_TS = new Date('2025-01-15T00:00:00Z').getTime();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const tsOffset = Math.floor(rng() * THIRTY_DAYS_MS);
  const ts = new Date(BASE_TS - tsOffset);

  // Severity distribution
  const sevRoll = rng();
  let severity = 'debug';
  for (const s of SEVERITY_THRESHOLDS) {
    if (sevRoll < s.threshold) {
      severity = s.level;
      break;
    }
  }

  const service = pickFrom(SERVICES, rng);

  // Choose template: debug/info use first 10 templates, warn/error can use all 20
  let templateRange;
  if (severity === 'debug' || severity === 'info') {
    templateRange = 10; // first 10 templates
  } else {
    templateRange = MESSAGE_TEMPLATES.length; // all templates including selective ones
  }
  const templateIdx = Math.floor(rng() * templateRange);
  const message = generateMessage(templateIdx, rng);

  return { ts, severity, service, message };
}

async function initDb() {
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

  // Check whether we need to seed
  const countResult = await db.query('SELECT COUNT(*)::int AS cnt FROM logs');
  const existingCount = countResult.rows[0].cnt;

  if (existingCount >= TOTAL_ROWS) {
    console.log(`[seed] Table already has ${existingCount} rows, skipping seed.`);
  } else {
    if (existingCount > 0) {
      console.log(`[seed] Partial data found (${existingCount} rows), truncating and reseeding...`);
      await db.exec('TRUNCATE logs RESTART IDENTITY');
    }

    console.log(`[seed] Seeding ${TOTAL_ROWS} rows in batches of ${BATCH_SIZE}...`);
    const seedStart = Date.now();
    const rng = mulberry32(42); // deterministic seed

    // Generate all rows first, then batch insert
    for (let batchStart = 0; batchStart < TOTAL_ROWS; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL_ROWS);
      const batchCount = batchEnd - batchStart;

      // Build multi-row INSERT
      const valueParts = [];
      const params = [];
      for (let i = 0; i < batchCount; i++) {
        const row = generateRow(batchStart + i, rng);
        const base = i * 4;
        valueParts.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
        params.push(row.ts.toISOString(), row.severity, row.service, row.message);
      }

      await db.query(
        `INSERT INTO logs (ts, severity, service, message) VALUES ${valueParts.join(', ')}`,
        params
      );

      if ((batchStart + batchCount) % 20000 === 0 || batchStart + batchCount === TOTAL_ROWS) {
        console.log(`[seed] Inserted ${batchStart + batchCount} / ${TOTAL_ROWS} rows (${Date.now() - seedStart}ms)`);
      }
    }

    console.log(`[seed] Seeding complete in ${Date.now() - seedStart}ms`);

    // Create indexes after bulk insert for speed
    console.log('[index] Creating indexes...');
    const idxStart = Date.now();

    await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC)');
    // pg_trgm not available in PGlite, so we use a lower() index for case-insensitive search
    // For substring search, we rely on sequential scan with ILIKE but the severity+ts index helps when severity is also filtered
    await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_lower_message ON logs (lower(message) text_pattern_ops)');

    console.log(`[index] Indexes created in ${Date.now() - idxStart}ms`);
  }

  return db;
}

module.exports = { initDb };
