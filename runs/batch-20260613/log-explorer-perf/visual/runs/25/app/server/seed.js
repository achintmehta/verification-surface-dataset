/**
 * Deterministic seed generator for 100,000 log entries.
 * Uses a simple seeded PRNG for reproducibility.
 */

// Simple mulberry32 PRNG
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
const BATCH_SIZE = 2000;

const SEVERITIES = ['debug', 'info', 'warn', 'error'];
// Distribution: ~60% debug, ~25% info, ~10% warn, ~5% error
// Cumulative: 0.60, 0.85, 0.95, 1.00
const SEVERITY_THRESHOLDS = [0.60, 0.85, 0.95, 1.00];

const SERVICES = [
  'api-gateway',
  'auth-service',
  'user-service',
  'payment-service',
  'notification-service',
  'search-service',
  'analytics-service',
  'file-service',
];

// Message templates with variable fragments.
// Selective terms: "timeout", "circuit breaker", "rate limit", "deadlock"
// Non-selective terms: "request", "response", "processing", "completed"
const TEMPLATES = [
  // debug messages (common)
  (rng) => `Processing request for endpoint ${pick(rng, ['/api/users', '/api/orders', '/api/products', '/api/health', '/api/search'])}`,
  (rng) => `Cache ${pick(rng, ['hit', 'miss', 'eviction'])} for key ${pick(rng, ['user:123', 'session:abc', 'config:main', 'rate:ip'])}`,
  (rng) => `Database query completed in ${Math.floor(rng() * 500)}ms on table ${pick(rng, ['users', 'orders', 'sessions', 'logs'])}`,
  (rng) => `Request received from ${pick(rng, ['10.0.0.1', '192.168.1.50', '172.16.0.100', '10.1.2.3'])} with ${Math.floor(rng() * 10)} headers`,
  (rng) => `Response sent with status ${pick(rng, ['200', '201', '204', '301'])} in ${Math.floor(rng() * 200)}ms`,
  (rng) => `Memory usage: heap ${Math.floor(rng() * 512)}MB, RSS ${Math.floor(rng() * 1024)}MB`,
  (rng) => `Background job ${pick(rng, ['email-digest', 'cleanup', 'sync', 'report-gen'])} scheduled for processing`,
  (rng) => `Connection pool stats: active=${Math.floor(rng() * 20)}, idle=${Math.floor(rng() * 10)}, waiting=${Math.floor(rng() * 5)}`,

  // info messages (moderate)
  (rng) => `User ${pick(rng, ['alice', 'bob', 'charlie', 'diana', 'eve'])} logged in from ${pick(rng, ['web', 'mobile', 'api'])} client`,
  (rng) => `Order #${Math.floor(rng() * 100000)} completed successfully, total $${(rng() * 500).toFixed(2)}`,
  (rng) => `Deployment ${pick(rng, ['v1.2.3', 'v1.3.0', 'v2.0.0-rc1', 'v1.2.4-hotfix'])} rolled out to ${pick(rng, ['production', 'staging', 'canary'])}`,
  (rng) => `Health check passed: all ${Math.floor(rng() * 5) + 3} dependencies responding`,
  (rng) => `File uploaded: ${pick(rng, ['report.pdf', 'avatar.png', 'export.csv', 'backup.sql'])} (${Math.floor(rng() * 10000)}KB)`,

  // warn messages (less common)
  (rng) => `High latency detected: request took ${Math.floor(rng() * 5000) + 1000}ms to complete processing`,
  (rng) => `Rate limit approaching for client ${pick(rng, ['client-a', 'client-b', 'mobile-app'])} (${Math.floor(rng() * 100) + 80}% of quota used)`,
  (rng) => `Retry attempt ${Math.floor(rng() * 5) + 1} for upstream service ${pick(rng, ['payments', 'email', 'sms'])} request`,
  (rng) => `Disk usage at ${Math.floor(rng() * 20) + 75}% on volume ${pick(rng, ['/data', '/logs', '/tmp'])}`,
  (rng) => `Connection timeout after ${Math.floor(rng() * 30) + 5}s to ${pick(rng, ['redis', 'postgres', 'elasticsearch'])} timeout occurred`,

  // error messages (rare)
  (rng) => `Circuit breaker opened for service ${pick(rng, ['payment-gateway', 'email-provider', 'sms-gateway'])} after ${Math.floor(rng() * 10) + 5} failures`,
  (rng) => `Deadlock detected in transaction ${Math.floor(rng() * 10000)}, rolling back after timeout`,
  (rng) => `Unhandled exception in request handler: ${pick(rng, ['NullPointerException', 'OutOfMemoryError', 'ConnectionRefused', 'TypeError'])}`,
  (rng) => `Database connection lost, attempting reconnect (attempt ${Math.floor(rng() * 10) + 1}) after timeout`,
];

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function getSeverity(rng) {
  const r = rng();
  for (let i = 0; i < SEVERITY_THRESHOLDS.length; i++) {
    if (r < SEVERITY_THRESHOLDS[i]) return SEVERITIES[i];
  }
  return SEVERITIES[3];
}

/**
 * Seeds the database with 100,000 log entries in batches.
 * @param {import('@electric-sql/pglite').PGlite} db
 */
async function seedDatabase(db) {
  const rng = mulberry32(42); // deterministic seed

  // 30-day span ending now-ish (fixed reference for determinism)
  const endTs = new Date('2025-06-13T00:00:00Z').getTime();
  const startTs = endTs - 30 * 24 * 60 * 60 * 1000;
  const span = endTs - startTs;

  console.log(`Seeding ${TOTAL_ROWS} log entries in batches of ${BATCH_SIZE}...`);
  const seedStart = Date.now();

  for (let batchStart = 0; batchStart < TOTAL_ROWS; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL_ROWS);
    const batchCount = batchEnd - batchStart;

    // Build a single INSERT with multiple value rows
    const values = [];
    const params = [];

    for (let i = 0; i < batchCount; i++) {
      const idx = batchStart + i;
      // Generate timestamp: spread across 30 days, slightly randomized but monotonically increasing overall
      const baseTs = startTs + (idx / TOTAL_ROWS) * span;
      const jitter = (rng() - 0.5) * 60000; // ±30 seconds jitter
      const ts = new Date(baseTs + jitter).toISOString();

      const severity = getSeverity(rng);
      const service = pick(rng, SERVICES);
      const templateIdx = Math.floor(rng() * TEMPLATES.length);
      const message = TEMPLATES[templateIdx](rng);

      const offset = i * 4;
      values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`);
      params.push(ts, severity, service, message);
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`;
    await db.query(sql, params);

    if ((batchStart + batchCount) % 10000 === 0 || batchStart + batchCount === TOTAL_ROWS) {
      console.log(`  Seeded ${batchStart + batchCount}/${TOTAL_ROWS} rows (${Date.now() - seedStart}ms elapsed)`);
    }
  }

  console.log(`Seeding complete in ${Date.now() - seedStart}ms`);
}

module.exports = { seedDatabase, TOTAL_ROWS };
