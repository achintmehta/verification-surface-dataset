/**
 * Deterministic seed generator for 100,000 log entries.
 * 
 * Uses a simple seeded PRNG (mulberry32) so the corpus is identical across runs.
 * Distribution: debug 60%, info 25%, warn 10%, error 5%
 * Span: 30 days across 8 services
 */

// Mulberry32 PRNG – deterministic, fast
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOTAL_ROWS = 100_000;
const SERVICES = [
  'api-gateway',
  'auth-service',
  'user-service',
  'order-service',
  'payment-service',
  'notification-service',
  'inventory-service',
  'analytics-service',
];

// Severity thresholds for cumulative distribution: debug 60%, info 25%, warn 10%, error 5%
const SEVERITY_THRESHOLDS = [
  { threshold: 0.60, severity: 'debug' },
  { threshold: 0.85, severity: 'info' },
  { threshold: 0.95, severity: 'warn' },
  { threshold: 1.00, severity: 'error' },
];

// Message templates with variable fragments.
// Some terms are selective (rare), some are non-selective (common).
const MESSAGE_TEMPLATES = [
  // Non-selective (common) terms: "request", "response", "processing", "completed"
  'Incoming request from client {ip}',
  'Response sent to client {ip} with status {status}',
  'Processing request for endpoint {endpoint}',
  'Request completed in {duration}ms',
  'Cache hit for key {cacheKey}',
  'Cache miss for key {cacheKey}, fetching from database',
  'Database query executed in {duration}ms',
  'Connection pool status: {poolActive} active, {poolIdle} idle',
  'Health check passed for service {service}',
  'Configuration reloaded from environment',
  // Selective (rare) terms: "deadlock", "circuit-breaker", "failover", "panic"
  'Deadlock detected in transaction {txId}, retrying',
  'Circuit-breaker opened for downstream service {service}',
  'Failover triggered: switching from primary to replica',
  'Panic recovery: caught unexpected nil pointer in handler {endpoint}',
  'Rate limit exceeded for client {ip}: {rateCount} requests in {rateWindow}s',
  'Memory usage warning: heap at {heapPct}% capacity',
  'Slow query detected: {sqlFragment} took {duration}ms',
  'Authentication token expired for user {userId}',
  'Retry attempt {retryNum} for message queue publish',
  'Graceful shutdown initiated, draining {drainCount} connections',
];

const IP_FRAGMENTS = [
  '10.0.1.42', '10.0.2.15', '192.168.1.100', '172.16.0.5',
  '10.0.3.88', '192.168.4.22', '10.10.0.1', '172.20.5.9',
];

const ENDPOINTS = [
  '/api/users', '/api/orders', '/api/payments', '/api/inventory',
  '/api/auth/login', '/api/auth/refresh', '/api/notifications', '/api/health',
];

const STATUS_CODES = ['200', '201', '204', '301', '400', '401', '403', '404', '500', '502', '503'];

const CACHE_KEYS = [
  'user:1001', 'user:2045', 'session:abc123', 'config:global',
  'rate:10.0.1.42', 'inventory:sku-9920', 'order:77431', 'token:xyz',
];

const SQL_FRAGMENTS = [
  'SELECT * FROM users WHERE email ILIKE',
  'UPDATE orders SET status =',
  'INSERT INTO audit_log',
  'DELETE FROM expired_sessions WHERE',
];

function pickSeverity(rand) {
  const r = rand();
  for (const { threshold, severity } of SEVERITY_THRESHOLDS) {
    if (r < threshold) return severity;
  }
  return 'error';
}

function fillTemplate(template, rand) {
  return template
    .replace('{ip}', IP_FRAGMENTS[Math.floor(rand() * IP_FRAGMENTS.length)])
    .replace('{status}', STATUS_CODES[Math.floor(rand() * STATUS_CODES.length)])
    .replace('{endpoint}', ENDPOINTS[Math.floor(rand() * ENDPOINTS.length)])
    .replace('{duration}', String(Math.floor(rand() * 5000) + 1))
    .replace('{cacheKey}', CACHE_KEYS[Math.floor(rand() * CACHE_KEYS.length)])
    .replace('{service}', SERVICES[Math.floor(rand() * SERVICES.length)])
    .replace('{poolActive}', String(Math.floor(rand() * 50)))
    .replace('{poolIdle}', String(Math.floor(rand() * 20)))
    .replace('{txId}', String(Math.floor(rand() * 100000)))
    .replace('{rateCount}', String(Math.floor(rand() * 500) + 100))
    .replace('{rateWindow}', String(Math.floor(rand() * 60) + 1))
    .replace('{heapPct}', String(Math.floor(rand() * 30) + 70))
    .replace('{sqlFragment}', SQL_FRAGMENTS[Math.floor(rand() * SQL_FRAGMENTS.length)])
    .replace('{userId}', String(Math.floor(rand() * 10000) + 1))
    .replace('{retryNum}', String(Math.floor(rand() * 5) + 1))
    .replace('{drainCount}', String(Math.floor(rand() * 200) + 1));
}

/**
 * Generate all 100k rows as an array of value tuples for batch insert.
 * Timestamps span 30 days backward from a fixed anchor, distributed uniformly.
 */
export function generateRows() {
  const rand = mulberry32(42); // deterministic seed

  // Anchor: 2025-01-15T00:00:00Z
  const anchorMs = Date.UTC(2025, 0, 15, 0, 0, 0);
  const spanMs = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

  const rows = new Array(TOTAL_ROWS);

  for (let i = 0; i < TOTAL_ROWS; i++) {
    const tsOffset = Math.floor(rand() * spanMs);
    const ts = new Date(anchorMs - spanMs + tsOffset);
    const severity = pickSeverity(rand);
    const service = SERVICES[Math.floor(rand() * SERVICES.length)];
    const template = MESSAGE_TEMPLATES[Math.floor(rand() * MESSAGE_TEMPLATES.length)];
    const message = fillTemplate(template, rand);

    rows[i] = {
      ts: ts.toISOString(),
      severity,
      service,
      message,
    };
  }

  return rows;
}

/**
 * Batch-insert rows into PGLite. Uses multi-value INSERT for speed.
 */
export async function seedDatabase(db) {
  // Check if already seeded
  const check = await db.query('SELECT count(*)::int AS cnt FROM logs');
  const existingCount = check.rows[0].cnt;
  if (existingCount >= TOTAL_ROWS) {
    console.log(`Database already seeded with ${existingCount} rows. Skipping.`);
    return false; // did not seed
  }

  console.log('Seeding 100,000 log entries...');
  const startTime = Date.now();

  const rows = generateRows();

  // Insert in batches of 1000
  const BATCH_SIZE = 1000;
  for (let batchStart = 0; batchStart < rows.length; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, rows.length);
    const batch = rows.slice(batchStart, batchEnd);

    // Build parameterized multi-row INSERT
    const valueClauses = [];
    const params = [];
    for (let i = 0; i < batch.length; i++) {
      const base = i * 4;
      valueClauses.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
      params.push(batch[i].ts, batch[i].severity, batch[i].service, batch[i].message);
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${valueClauses.join(', ')}`;
    await db.query(sql, params);

    if ((batchStart + BATCH_SIZE) % 10000 === 0 || batchEnd === rows.length) {
      console.log(`  Inserted ${batchEnd} / ${rows.length} rows...`);
    }
  }

  const elapsed = Date.now() - startTime;
  console.log(`Seeding complete in ${elapsed}ms`);
  return true; // did seed
}
