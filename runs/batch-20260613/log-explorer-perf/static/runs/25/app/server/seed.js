/**
 * Deterministic seed of exactly 100,000 log entries.
 *
 * - Spans 30 days ending "now" (fixed reference: 2025-01-15T00:00:00Z for determinism)
 * - 8 services
 * - Severity distribution: ~60% info, ~25% debug, ~10% warn, ~5% error
 * - Messages from templates with variable fragments; some substrings are selective,
 *   others non-selective (e.g. "request" appears often, "deadlock" is rare).
 */

const TOTAL_ROWS = 100000;
const BATCH_SIZE = 2000;

// Fixed reference point for determinism
const END_TS = new Date('2025-01-15T00:00:00Z').getTime();
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const START_TS = END_TS - THIRTY_DAYS_MS;

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

// Severity weights: cumulative thresholds out of 100
// debug ~25%, info ~60%, warn ~10%, error ~5%
const SEVERITY_THRESHOLDS = [
  { severity: 'debug', cumulative: 25 },
  { severity: 'info', cumulative: 85 },
  { severity: 'warn', cumulative: 95 },
  { severity: 'error', cumulative: 100 },
];

// Message templates. {0}, {1}, etc are replaced by fragments.
// Some terms appear in many templates (non-selective: "request", "completed", "processing")
// Some terms appear in few templates (selective: "deadlock", "circuit breaker", "out of memory")
const TEMPLATES = [
  // info - common (non-selective terms: request, completed, processing)
  { msg: 'Incoming request from {ip} to {endpoint}', severity: 'info' },
  { msg: 'Request completed in {latency}ms with status {status}', severity: 'info' },
  { msg: 'Processing request for user {userid}', severity: 'info' },
  { msg: 'Database query completed in {latency}ms returning {rows} rows', severity: 'info' },
  { msg: 'Cache hit for key {cachekey}', severity: 'info' },
  { msg: 'Cache miss for key {cachekey}, fetching from database', severity: 'info' },
  { msg: 'Health check passed', severity: 'info' },
  { msg: 'Configuration reloaded successfully', severity: 'info' },
  { msg: 'Connection pool size: {poolsize} active, {poolidle} idle', severity: 'info' },
  { msg: 'Scheduled task {taskname} started', severity: 'info' },

  // debug - common
  { msg: 'Entering function {funcname} with args: {args}', severity: 'debug' },
  { msg: 'Variable {varname} = {varval}', severity: 'debug' },
  { msg: 'SQL query: SELECT * FROM {table} WHERE id = {id}', severity: 'debug' },
  { msg: 'HTTP {method} {endpoint} headers: {headers}', severity: 'debug' },
  { msg: 'Serializing response payload ({bytes} bytes)', severity: 'debug' },
  { msg: 'Retry attempt {attempt} for operation {operation}', severity: 'debug' },

  // warn - less common
  { msg: 'Slow query detected: {latency}ms on {table}', severity: 'warn' },
  { msg: 'Connection pool nearly exhausted: {poolsize} of {poolmax} in use', severity: 'warn' },
  { msg: 'Deprecated API endpoint {endpoint} called by {ip}', severity: 'warn' },
  { msg: 'Rate limit approaching for client {clientid}: {rate}/s', severity: 'warn' },
  { msg: 'Request timeout after {latency}ms for {endpoint}', severity: 'warn' },

  // error - rare (selective terms: deadlock, circuit breaker, out of memory, stack overflow, panic)
  { msg: 'Deadlock detected on table {table} between transactions {txid1} and {txid2}', severity: 'error' },
  { msg: 'Circuit breaker opened for service {targetservice} after {failures} failures', severity: 'error' },
  { msg: 'Out of memory: heap usage {heapmb}MB exceeds limit {limitmb}MB', severity: 'error' },
  { msg: 'Unhandled exception in {funcname}: {exception}', severity: 'error' },
  { msg: 'Database connection failed: {dberror}', severity: 'error' },
  { msg: 'Stack overflow in recursive call to {funcname}', severity: 'error' },
  { msg: 'Panic: unexpected nil pointer in {funcname}', severity: 'error' },
];

// Fragment pools for template variables
const FRAGMENTS = {
  ip: ['192.168.1.100', '10.0.0.42', '172.16.0.5', '10.0.1.88', '192.168.0.201', '10.10.10.10', '172.31.0.99', '203.0.113.15'],
  endpoint: ['/api/users', '/api/orders', '/api/payments', '/api/health', '/api/auth/login', '/api/auth/logout', '/api/inventory', '/api/notifications', '/api/analytics/report', '/api/config'],
  latency: ['12', '45', '123', '256', '512', '1024', '2048', '5000', '8', '3'],
  status: ['200', '201', '204', '301', '400', '401', '403', '404', '500', '502', '503'],
  userid: ['usr_001', 'usr_042', 'usr_100', 'usr_999', 'usr_500', 'usr_123', 'usr_777', 'usr_050'],
  rows: ['0', '1', '5', '12', '42', '100', '250', '1000'],
  cachekey: ['user:42', 'order:1001', 'session:abc', 'config:main', 'inventory:sku_100', 'rate:client_5'],
  poolsize: ['5', '10', '15', '20', '25', '30', '45', '48'],
  poolidle: ['2', '5', '10', '15', '0', '1'],
  poolmax: ['50', '100'],
  taskname: ['cleanup', 'report_gen', 'email_digest', 'cache_warm', 'index_rebuild'],
  funcname: ['handleRequest', 'processOrder', 'validateToken', 'fetchUser', 'updateInventory', 'sendNotification', 'computeAnalytics', 'parsePayload'],
  args: ['{ id: 42 }', '{ page: 1 }', '{ token: "..." }', '{ sku: "ABC" }'],
  varname: ['retryCount', 'batchSize', 'timeout', 'threshold', 'maxConnections'],
  varval: ['3', '100', '5000', '0.95', '42', 'true', 'null'],
  table: ['users', 'orders', 'payments', 'sessions', 'inventory', 'notifications', 'audit_log'],
  id: ['1', '42', '100', '999', '50000', '12345'],
  method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  headers: ['{ accept: "application/json" }', '{ content-type: "text/html" }'],
  bytes: ['128', '512', '1024', '4096', '16384', '65536'],
  attempt: ['1', '2', '3', '4', '5'],
  operation: ['db_write', 'http_call', 'cache_set', 'queue_push'],
  clientid: ['client_1', 'client_7', 'client_42', 'client_99'],
  rate: ['95', '98', '100', '150', '200'],
  targetservice: ['auth-service', 'payment-service', 'inventory-service', 'notification-service'],
  failures: ['5', '10', '15', '20', '50'],
  heapmb: ['512', '768', '1024', '1500', '2048'],
  limitmb: ['512', '1024'],
  exception: ['TypeError: Cannot read property of undefined', 'RangeError: Maximum call stack', 'Error: ECONNREFUSED', 'Error: ETIMEDOUT'],
  dberror: ['ECONNREFUSED 5432', 'timeout after 30000ms', 'too many connections', 'authentication failed'],
  txid1: ['tx_001', 'tx_042', 'tx_100'],
  txid2: ['tx_002', 'tx_043', 'tx_101'],
};

/**
 * Simple deterministic PRNG (mulberry32).
 * Takes a 32-bit seed, returns a function that yields [0,1) floats.
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

function pickSeverity(rand) {
  const r = Math.floor(rand() * 100);
  for (const { severity, cumulative } of SEVERITY_THRESHOLDS) {
    if (r < cumulative) return severity;
  }
  return 'info';
}

function pickFrom(arr, rand) {
  return arr[Math.floor(rand() * arr.length)];
}

function expandTemplate(template, rand) {
  return template.replace(/\{(\w+)\}/g, (_match, key) => {
    const pool = FRAGMENTS[key];
    if (!pool) return key;
    return pickFrom(pool, rand);
  });
}

async function seedDatabase(db) {
  const rand = mulberry32(42);
  const totalBatches = Math.ceil(TOTAL_ROWS / BATCH_SIZE);

  console.log(`[seed] Seeding ${TOTAL_ROWS} rows in ${totalBatches} batches of ${BATCH_SIZE}...`);
  const seedStart = Date.now();

  // Pre-generate all rows, then batch-insert them
  for (let batch = 0; batch < totalBatches; batch++) {
    const batchStart = batch * BATCH_SIZE;
    const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL_ROWS);

    // Build a single INSERT with multiple value tuples
    const params = [];
    const valueClauses = [];
    let paramIdx = 1;

    for (let i = batchStart; i < batchEnd; i++) {
      // Deterministic timestamp: evenly space across 30 days with small jitter
      const baseTs = START_TS + (i / TOTAL_ROWS) * THIRTY_DAYS_MS;
      const jitter = (rand() - 0.5) * 60000; // ±30 seconds jitter
      const ts = new Date(baseTs + jitter).toISOString();

      const severity = pickSeverity(rand);
      const service = pickFrom(SERVICES, rand);

      // Pick a template that matches the chosen severity
      const matchingTemplates = TEMPLATES.filter((t) => t.severity === severity);
      const template = pickFrom(matchingTemplates, rand);
      const message = expandTemplate(template.msg, rand);

      valueClauses.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3})`);
      params.push(ts, severity, service, message);
      paramIdx += 4;
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${valueClauses.join(', ')}`;
    await db.query(sql, params);

    if ((batch + 1) % 10 === 0 || batch === totalBatches - 1) {
      const elapsed = ((Date.now() - seedStart) / 1000).toFixed(1);
      console.log(`[seed] Batch ${batch + 1}/${totalBatches} (${batchEnd} rows) - ${elapsed}s`);
    }
  }

  const totalTime = ((Date.now() - seedStart) / 1000).toFixed(1);
  console.log(`[seed] Seeding complete: ${TOTAL_ROWS} rows in ${totalTime}s`);
}

module.exports = { seedDatabase };
