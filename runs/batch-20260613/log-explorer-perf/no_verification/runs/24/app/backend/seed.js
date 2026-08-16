/**
 * Deterministic seed generator for 100,000 log entries.
 * 
 * Uses a simple seeded PRNG to produce repeatable data:
 * - 30-day span
 * - 8 services
 * - Severity distribution: ~60% info, ~25% debug, ~10% warn, ~5% error
 * - Messages from templates with variable fragments
 */

// Simple mulberry32 PRNG for determinism
function mulberry32(seed) {
  return function() {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
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

// Severity thresholds: 60% info, 25% debug, 10% warn, 5% error
function getSeverity(rand) {
  if (rand < 0.60) return 'info';
  if (rand < 0.85) return 'debug';
  if (rand < 0.95) return 'warn';
  return 'error';
}

// Message templates with variable fragments
// Some terms are selective (rare), some are non-selective (common)
const MESSAGE_TEMPLATES = [
  // Common/non-selective patterns
  (rng) => `Request processed in ${Math.floor(rng() * 500) + 1}ms`,
  (rng) => `Handling incoming request from ${pickFrom(rng, ['10.0.0.1', '10.0.0.2', '192.168.1.100', '172.16.0.5'])}`,
  (rng) => `Database query completed successfully in ${Math.floor(rng() * 200) + 1}ms`,
  (rng) => `Cache ${pickFrom(rng, ['hit', 'miss'])} for key user:${Math.floor(rng() * 10000)}`,
  (rng) => `Health check passed, uptime ${Math.floor(rng() * 86400)}s`,
  (rng) => `Connection pool status: ${Math.floor(rng() * 20) + 1} active, ${Math.floor(rng() * 10)} idle`,
  (rng) => `Processed message from queue ${pickFrom(rng, ['orders', 'notifications', 'events', 'payments'])}`,
  (rng) => `HTTP ${pickFrom(rng, ['GET', 'POST', 'PUT', 'DELETE'])} /api/${pickFrom(rng, ['users', 'orders', 'products', 'health'])} completed`,
  (rng) => `Rate limiter: ${Math.floor(rng() * 100)} requests in current window`,
  (rng) => `Memory usage: ${Math.floor(rng() * 512) + 128}MB / 1024MB`,

  // Moderately selective patterns
  (rng) => `Timeout waiting for downstream service ${pickFrom(rng, SERVICES)} after ${Math.floor(rng() * 30000) + 5000}ms`,
  (rng) => `Retrying failed operation, attempt ${Math.floor(rng() * 5) + 1} of 5`,
  (rng) => `Circuit breaker ${pickFrom(rng, ['opened', 'closed', 'half-open'])} for ${pickFrom(rng, SERVICES)}`,
  (rng) => `Slow query detected: ${Math.floor(rng() * 5000) + 1000}ms on table ${pickFrom(rng, ['users', 'orders', 'sessions', 'products'])}`,
  (rng) => `Configuration reloaded from ${pickFrom(rng, ['consul', 'vault', 'env', 'file'])}`,

  // Selective/rare patterns
  (rng) => `CRITICAL: Disk usage exceeded ${Math.floor(rng() * 10) + 90}% threshold on volume ${pickFrom(rng, ['/data', '/logs', '/tmp'])}`,
  (rng) => `OutOfMemoryError: heap space exhausted, triggering GC cycle ${Math.floor(rng() * 100)}`,
  (rng) => `SecurityAlert: Unauthorized access attempt from IP ${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}`,
  (rng) => `DataCorruption: Checksum mismatch on block ${Math.floor(rng() * 10000)}, initiating repair`,
  (rng) => `DeadlockDetected: Transactions ${Math.floor(rng() * 10000)} and ${Math.floor(rng() * 10000)} on table ${pickFrom(rng, ['orders', 'inventory'])}`,
];

function pickFrom(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Escape a string for safe inclusion in a SQL string literal.
 */
function escapeSql(str) {
  return str.replace(/'/g, "''");
}

/**
 * Generate a batch INSERT SQL statement for rows [startIdx, endIdx).
 * 
 * Base date: 2024-01-01T00:00:00Z
 * Span: 30 days = 2,592,000 seconds
 * 100,000 rows spread over 30 days = one row every ~25.92 seconds on average.
 */
function generateSeedSQL(startIdx, endIdx) {
  const BASE_TS = new Date('2024-01-01T00:00:00Z').getTime();
  const SPAN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days in ms
  const TOTAL = 100000;

  const values = [];

  for (let i = startIdx; i < endIdx; i++) {
    // Deterministic RNG seeded per row
    const rng = mulberry32(i * 7919 + 42);

    // Timestamp: evenly distributed across the span with small jitter
    const baseOffset = (i / TOTAL) * SPAN_MS;
    const jitter = (rng() - 0.5) * (SPAN_MS / TOTAL) * 0.8;
    const ts = new Date(BASE_TS + baseOffset + jitter);
    const tsStr = ts.toISOString().replace('T', ' ').replace('Z', '');

    // Severity
    const severity = getSeverity(rng());

    // Service
    const service = pickFrom(rng, SERVICES);

    // Message
    const templateIdx = Math.floor(rng() * MESSAGE_TEMPLATES.length);
    const message = MESSAGE_TEMPLATES[templateIdx](rng);

    values.push(`('${tsStr}', '${severity}', '${escapeSql(service)}', '${escapeSql(message)}')`);
  }

  return `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',\n')}`;
}

module.exports = { generateSeedSQL };
