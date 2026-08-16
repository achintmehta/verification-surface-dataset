/**
 * Deterministic seed of exactly 100,000 log entries.
 * Uses a simple LCG (linear congruential generator) for determinism.
 * Batches inserts for performance.
 */

const TOTAL_ROWS = 100_000;
const BATCH_SIZE = 500; // 500 rows × 4 params = 2000 params per batch (safe limit)

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

// Severity distribution: ~60% debug, ~25% info, ~10% warn, ~5% error
const SEVERITY_WEIGHTS = [
  { severity: 'debug', weight: 60 },
  { severity: 'info',  weight: 25 },
  { severity: 'warn',  weight: 10 },
  { severity: 'error', weight: 5  },
];

// Build cumulative weights for O(1) lookup
const SEVERITY_CUM = [];
let cumSum = 0;
for (const { severity, weight } of SEVERITY_WEIGHTS) {
  cumSum += weight;
  SEVERITY_CUM.push({ severity, cum: cumSum });
}
const SEVERITY_TOTAL = cumSum; // 100

// Message templates with variable fragments
// Some terms are selective (rare), some are non-selective (common)
const MESSAGE_TEMPLATES = [
  // debug (indices 0-7)
  (vars) => `Processing request ${vars.reqId} for user ${vars.userId} on endpoint ${vars.endpoint}`,
  (vars) => `Cache ${vars.cacheOp} for key ${vars.cacheKey} in ${vars.duration}ms`,
  (vars) => `Database query executed in ${vars.duration}ms rows_affected=${vars.rows}`,
  (vars) => `Heartbeat check passed latency=${vars.duration}ms node=${vars.nodeId}`,
  (vars) => `Config reload triggered by ${vars.trigger} at ${vars.configKey}`,
  (vars) => `Span ${vars.spanId} started for operation ${vars.operation}`,
  (vars) => `Retry attempt ${vars.attempt} for job ${vars.jobId} backoff=${vars.duration}ms`,
  (vars) => `Token validation succeeded for subject ${vars.userId} scope=${vars.scope}`,
  // info (indices 8-15)
  (vars) => `User ${vars.userId} logged in from ${vars.ip} using ${vars.authMethod}`,
  (vars) => `Order ${vars.orderId} created by user ${vars.userId} total=${vars.amount}`,
  (vars) => `Payment ${vars.paymentId} processed successfully amount=${vars.amount} method=${vars.payMethod}`,
  (vars) => `Notification sent to ${vars.userId} via ${vars.channel} template=${vars.template}`,
  (vars) => `Inventory updated for product ${vars.productId} delta=${vars.delta} warehouse=${vars.warehouse}`,
  (vars) => `Session ${vars.sessionId} established for user ${vars.userId}`,
  (vars) => `Deployment ${vars.deployId} completed for service ${vars.service} version=${vars.version}`,
  (vars) => `Rate limit applied to ${vars.ip} on route ${vars.endpoint} limit=${vars.rateLimit}`,
  // warn (indices 16-21)
  (vars) => `Slow query detected duration=${vars.duration}ms query_hash=${vars.queryHash}`,
  (vars) => `Memory usage high rss=${vars.rss}MB heap=${vars.heap}MB threshold exceeded`,
  (vars) => `Deprecated API endpoint ${vars.endpoint} called by ${vars.userId}`,
  (vars) => `Connection pool exhausted waiting=${vars.waiting} pool_size=${vars.poolSize}`,
  (vars) => `Certificate expiry approaching days_remaining=${vars.days} domain=${vars.domain}`,
  (vars) => `Disk usage at ${vars.diskPct}% on volume ${vars.volume} approaching limit`,
  // error (indices 22-25)
  (vars) => `CRITICAL: Payment ${vars.paymentId} failed error=${vars.errorCode} user=${vars.userId}`,
  (vars) => `Unhandled exception in ${vars.service} at ${vars.endpoint} error=${vars.errorCode}`,
  (vars) => `Database connection lost host=${vars.dbHost} retrying in ${vars.duration}ms`,
  (vars) => `Authentication failure for user ${vars.userId} from ${vars.ip} reason=${vars.errorCode}`,
];

// Variable fragment pools
const ENDPOINTS = [
  '/api/users', '/api/orders', '/api/payments', '/api/products',
  '/api/auth/login', '/api/auth/logout', '/api/inventory', '/api/notifications',
  '/health', '/metrics', '/api/search', '/api/reports',
];
const AUTH_METHODS = ['oauth2', 'jwt', 'saml', 'basic', 'apikey'];
const CHANNELS = ['email', 'sms', 'push', 'webhook', 'slack'];
const TEMPLATES = ['welcome', 'order-confirm', 'password-reset', 'alert', 'digest'];
const PAY_METHODS = ['card', 'paypal', 'bank-transfer', 'crypto', 'wallet'];
const CACHE_OPS = ['hit', 'miss', 'evict', 'set', 'invalidate'];
const SCOPES = ['read', 'write', 'admin', 'readonly', 'billing'];
const TRIGGERS = ['file-watch', 'api-call', 'schedule', 'signal', 'startup'];
const OPERATIONS = ['db-read', 'db-write', 'cache-get', 'http-call', 'queue-publish'];
const ERROR_CODES = ['ERR_TIMEOUT', 'ERR_CONN_REFUSED', 'ERR_AUTH_INVALID', 'ERR_RATE_LIMIT', 'ERR_INTERNAL'];
const DOMAINS = ['api.example.com', 'auth.example.com', 'cdn.example.com', 'ws.example.com'];
const VOLUMES = ['/dev/sda1', '/dev/sdb1', '/mnt/data', '/mnt/logs'];

/**
 * Simple LCG random number generator for determinism.
 * Returns a function that yields integers in [0, 2^31).
 */
function makeLCG(seed) {
  let state = seed >>> 0;
  return function() {
    // Parameters from Numerical Recipes
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state;
  };
}

function pickFrom(arr, rng) {
  return arr[rng() % arr.length];
}

function randInt(min, max, rng) {
  // Returns integer in [min, max]
  return min + (rng() % (max - min + 1));
}

function pickSeverity(rng) {
  const r = rng() % SEVERITY_TOTAL;
  for (const { severity, cum } of SEVERITY_CUM) {
    if (r < cum) return severity;
  }
  return 'debug';
}

function generateVars(rng) {
  return {
    reqId:     `req-${(rng() % 0xFFFFFF).toString(16).padStart(6, '0')}`,
    userId:    `usr-${(rng() % 99999).toString().padStart(5, '0')}`,
    orderId:   `ord-${(rng() % 999999).toString().padStart(6, '0')}`,
    paymentId: `pay-${(rng() % 999999).toString().padStart(6, '0')}`,
    productId: `prd-${(rng() % 9999).toString().padStart(4, '0')}`,
    sessionId: `ses-${(rng() % 0xFFFFFF).toString(16).padStart(6, '0')}`,
    deployId:  `dep-${(rng() % 9999).toString().padStart(4, '0')}`,
    spanId:    `spn-${(rng() % 0xFFFFFF).toString(16).padStart(6, '0')}`,
    jobId:     `job-${(rng() % 9999).toString().padStart(4, '0')}`,
    nodeId:    `node-${(rng() % 16).toString().padStart(2, '0')}`,
    queryHash: `qh-${(rng() % 0xFFFF).toString(16).padStart(4, '0')}`,
    cacheKey:  `ck:${pickFrom(['user', 'order', 'product', 'session', 'config'], rng)}:${(rng() % 9999).toString()}`,
    ip:        `${10 + rng() % 245}.${rng() % 256}.${rng() % 256}.${rng() % 256}`,
    duration:  randInt(1, 5000, rng),
    rows:      randInt(0, 10000, rng),
    amount:    (randInt(100, 99999, rng) / 100).toFixed(2),
    delta:     randInt(-100, 100, rng),
    warehouse: `wh-${String.fromCharCode(65 + rng() % 8)}`,
    rss:       randInt(100, 2048, rng),
    heap:      randInt(50, 1024, rng),
    days:      randInt(1, 30, rng),
    diskPct:   randInt(70, 99, rng),
    waiting:   randInt(0, 50, rng),
    poolSize:  randInt(5, 50, rng),
    rateLimit: randInt(10, 1000, rng),
    attempt:   randInt(1, 5, rng),
    version:   `${randInt(1, 9, rng)}.${randInt(0, 99, rng)}.${randInt(0, 99, rng)}`,
    configKey: `config.${pickFrom(['db', 'cache', 'auth', 'rate-limit', 'feature-flags'], rng)}`,
    dbHost:    `db-${randInt(1, 4, rng)}.internal`,
    domain:    pickFrom(DOMAINS, rng),
    volume:    pickFrom(VOLUMES, rng),
    endpoint:  pickFrom(ENDPOINTS, rng),
    authMethod:pickFrom(AUTH_METHODS, rng),
    channel:   pickFrom(CHANNELS, rng),
    template:  pickFrom(TEMPLATES, rng),
    payMethod: pickFrom(PAY_METHODS, rng),
    cacheOp:   pickFrom(CACHE_OPS, rng),
    scope:     pickFrom(SCOPES, rng),
    trigger:   pickFrom(TRIGGERS, rng),
    operation: pickFrom(OPERATIONS, rng),
    errorCode: pickFrom(ERROR_CODES, rng),
    service:   pickFrom(SERVICES, rng),
  };
}

export async function seedDatabase(db) {
  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*)::int AS cnt FROM logs');
  const existing = countResult.rows[0].cnt;

  if (existing >= TOTAL_ROWS) {
    console.log(`Database already seeded with ${existing} rows. Skipping seed.`);
    return;
  }

  if (existing > 0) {
    console.log(`Partial seed detected (${existing} rows). Truncating and reseeding...`);
    await db.exec('TRUNCATE TABLE logs RESTART IDENTITY');
  }

  console.log(`Seeding ${TOTAL_ROWS} log entries in batches of ${BATCH_SIZE}...`);
  const startTime = Date.now();

  const rng = makeLCG(0xDEADBEEF);

  // Span 30 days ending at a fixed point for determinism
  // Base timestamp: 2024-01-31T00:00:00Z
  const END_TS = 1706659200000; // 2024-01-31T00:00:00Z in ms
  const SPAN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days in ms
  const START_TS = END_TS - SPAN_MS;

  let inserted = 0;

  while (inserted < TOTAL_ROWS) {
    const batchSize = Math.min(BATCH_SIZE, TOTAL_ROWS - inserted);
    const rows = [];

    for (let i = 0; i < batchSize; i++) {
      const severity = pickSeverity(rng);
      const service = pickFrom(SERVICES, rng);

      // Deterministic timestamp spread across 30 days
      const tsOffset = rng() % SPAN_MS;
      const tsMs = START_TS + tsOffset;
      const ts = new Date(tsMs).toISOString();

      const vars = generateVars(rng);
      vars.service = service;

      // Pick template based on severity
      let templatePool;
      if (severity === 'debug') templatePool = MESSAGE_TEMPLATES.slice(0, 8);
      else if (severity === 'info') templatePool = MESSAGE_TEMPLATES.slice(8, 16);
      else if (severity === 'warn') templatePool = MESSAGE_TEMPLATES.slice(16, 22);
      else templatePool = MESSAGE_TEMPLATES.slice(22);

      const template = pickFrom(templatePool, rng);
      const message = template(vars);

      rows.push({ ts, severity, service, message });
    }

    // Build batch INSERT using multi-row VALUES
    const valuePlaceholders = [];
    const values = [];
    let pIdx = 1;

    for (const row of rows) {
      valuePlaceholders.push(`($${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++})`);
      values.push(row.ts, row.severity, row.service, row.message);
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${valuePlaceholders.join(', ')}`;
    await db.query(sql, values);

    inserted += batchSize;

    if (inserted % 10000 === 0 || inserted === TOTAL_ROWS) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  Seeded ${inserted}/${TOTAL_ROWS} rows (${elapsed}s elapsed)`);
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Seeding complete: ${TOTAL_ROWS} rows in ${totalTime}s`);
}
