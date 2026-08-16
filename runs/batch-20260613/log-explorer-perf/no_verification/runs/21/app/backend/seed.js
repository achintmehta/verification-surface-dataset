/**
 * Deterministic seed of exactly 100,000 log rows.
 *
 * - Spans 30 days back from a fixed anchor date
 * - 8 services
 * - Severity distribution: ~60% info, ~25% debug, ~10% warn, ~5% error
 * - Messages from templates with variable fragments
 * - Fully deterministic: same data every run
 */

const TOTAL_ROWS = 100_000;
const BATCH_SIZE = 2000;

const ANCHOR_DATE = new Date('2025-01-15T00:00:00Z');
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

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

// Severity distribution: cumulative thresholds out of 100
// debug ~25%, info ~60%, warn ~10%, error ~5%
const SEVERITY_THRESHOLDS = [
  { threshold: 25, severity: 'debug' },
  { threshold: 85, severity: 'info' },
  { threshold: 95, severity: 'warn' },
  { threshold: 100, severity: 'error' },
];

// Message templates with placeholders
const MESSAGE_TEMPLATES = [
  'Request processed successfully in {duration}ms',
  'Connection established to {endpoint}',
  'Cache miss for key {cacheKey}',
  'User {userId} authenticated via {authMethod}',
  'Database query completed in {duration}ms',
  'Rate limit exceeded for client {clientId}',
  'Health check passed with status {status}',
  'Configuration reloaded from {configSource}',
  'Retry attempt {attempt} for operation {operation}',
  'Memory usage at {memPercent}% of allocated heap',
  'Incoming request from {ipAddress} to {endpoint}',
  'Response sent with status code {statusCode}',
  'Failed to connect to upstream {endpoint}',
  'Timeout waiting for {operation} after {duration}ms',
  'Successfully processed batch of {batchSize} items',
  'Disk usage warning: {diskPercent}% capacity reached',
  'TLS handshake completed with {endpoint}',
  'Garbage collection paused for {duration}ms',
  'New deployment detected: version {version}',
  'Circuit breaker tripped for {endpoint}',
];

const ENDPOINTS = [
  'db-primary.internal:5432',
  'redis-cluster.internal:6379',
  'kafka-broker.internal:9092',
  'auth-api.internal:8443',
  'storage-api.internal:9000',
  'search-cluster.internal:9200',
];

const CACHE_KEYS = [
  'user:profile:*',
  'session:token:*',
  'config:feature-flags',
  'rate:limit:*',
  'inventory:stock:*',
  'order:summary:*',
];

const AUTH_METHODS = ['oauth2', 'jwt', 'api-key', 'saml', 'basic'];
const OPERATIONS = ['fetchUserProfile', 'processPayment', 'sendNotification', 'updateInventory', 'generateReport', 'syncData'];
const CONFIG_SOURCES = ['consul', 'vault', 'env-file', 'config-map', 'etcd'];
const VERSIONS = ['v2.1.0', 'v2.1.1', 'v2.2.0-rc1', 'v2.2.0', 'v3.0.0-beta'];
const STATUS_CODES = ['200', '201', '204', '301', '400', '401', '403', '404', '500', '502', '503'];

/**
 * Simple seeded PRNG (Mulberry32) for deterministic generation.
 */
function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function randInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function generateMessage(rng, templateIndex) {
  const template = MESSAGE_TEMPLATES[templateIndex];
  return template
    .replace('{duration}', String(randInt(rng, 1, 5000)))
    .replace('{endpoint}', pick(rng, ENDPOINTS))
    .replace('{cacheKey}', pick(rng, CACHE_KEYS))
    .replace('{userId}', 'user-' + String(randInt(rng, 1000, 9999)))
    .replace('{authMethod}', pick(rng, AUTH_METHODS))
    .replace('{clientId}', 'client-' + String(randInt(rng, 100, 999)))
    .replace('{status}', pick(rng, ['healthy', 'degraded', 'warming']))
    .replace('{configSource}', pick(rng, CONFIG_SOURCES))
    .replace('{attempt}', String(randInt(rng, 1, 5)))
    .replace('{operation}', pick(rng, OPERATIONS))
    .replace('{memPercent}', String(randInt(rng, 30, 98)))
    .replace('{ipAddress}', `10.${randInt(rng, 0, 255)}.${randInt(rng, 0, 255)}.${randInt(rng, 1, 254)}`)
    .replace('{statusCode}', pick(rng, STATUS_CODES))
    .replace('{batchSize}', String(randInt(rng, 10, 10000)))
    .replace('{diskPercent}', String(randInt(rng, 60, 99)))
    .replace('{version}', pick(rng, VERSIONS));
}

function getSeverity(rng) {
  const v = rng() * 100;
  for (const { threshold, severity } of SEVERITY_THRESHOLDS) {
    if (v < threshold) return severity;
  }
  return 'info';
}

/**
 * Generate all 100k rows deterministically and insert in batches.
 */
export async function seedDatabase(db) {
  const rng = mulberry32(42); // fixed seed for determinism

  console.log(`Seeding ${TOTAL_ROWS} log entries...`);
  const startTime = Date.now();

  // Pre-generate all rows for sorting by timestamp
  const rows = new Array(TOTAL_ROWS);
  for (let i = 0; i < TOTAL_ROWS; i++) {
    const tsOffset = rng() * THIRTY_DAYS_MS;
    const ts = new Date(ANCHOR_DATE.getTime() - tsOffset);
    const severity = getSeverity(rng);
    const service = pick(rng, SERVICES);
    const templateIndex = Math.floor(rng() * MESSAGE_TEMPLATES.length);
    const message = generateMessage(rng, templateIndex);
    rows[i] = { ts, severity, service, message };
  }

  // Sort by timestamp ascending for sequential inserts (helps with index building)
  rows.sort((a, b) => a.ts.getTime() - b.ts.getTime());

  // Batch insert
  for (let batchStart = 0; batchStart < TOTAL_ROWS; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL_ROWS);
    const batchRows = rows.slice(batchStart, batchEnd);

    // Build a multi-row INSERT with parameterized values
    const valuePlaceholders = [];
    const params = [];
    let paramIndex = 1;

    for (const row of batchRows) {
      valuePlaceholders.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3})`);
      params.push(row.ts.toISOString(), row.severity, row.service, row.message);
      paramIndex += 4;
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${valuePlaceholders.join(', ')}`;
    await db.query(sql, params);

    const progress = Math.round((batchEnd / TOTAL_ROWS) * 100);
    if (progress % 20 === 0 || batchEnd === TOTAL_ROWS) {
      console.log(`  Seeded ${batchEnd}/${TOTAL_ROWS} rows (${progress}%)`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Seeding complete in ${elapsed}s`);
}
