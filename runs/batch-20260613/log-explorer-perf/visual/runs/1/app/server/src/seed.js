/**
 * Deterministic seed generator for 100,000 log entries.
 * Uses a simple LCG PRNG so results are identical across boots.
 */

const SERVICES = [
  'auth-service',
  'api-gateway',
  'user-service',
  'payment-service',
  'notification-service',
  'inventory-service',
  'search-service',
  'analytics-service',
];

const SEVERITIES = ['debug', 'info', 'warn', 'error'];

// Severity distribution: ~60% debug, ~25% info, ~10% warn, ~5% error
// Cumulative thresholds out of 100
const SEVERITY_THRESHOLDS = [60, 85, 95, 100];

// Message templates with variable slots
const MESSAGE_TEMPLATES = [
  // debug
  (v) => `Processing request ${v.reqId} for user ${v.userId} on endpoint ${v.endpoint}`,
  (v) => `Cache lookup for key ${v.cacheKey} returned ${v.hit ? 'HIT' : 'MISS'} in ${v.latency}ms`,
  (v) => `Database query executed in ${v.latency}ms: SELECT FROM ${v.table} WHERE id=${v.id}`,
  (v) => `Connection pool stats: active=${v.active} idle=${v.idle} waiting=${v.waiting}`,
  (v) => `Serializing response payload of ${v.bytes} bytes for request ${v.reqId}`,
  (v) => `Token validation completed for user ${v.userId} in ${v.latency}ms`,
  (v) => `Retry attempt ${v.attempt} of ${v.maxAttempts} for operation ${v.op}`,
  (v) => `Scheduled job ${v.jobName} started at ${v.startTime} with params ${v.params}`,
  // info
  (v) => `User ${v.userId} logged in successfully from IP ${v.ip}`,
  (v) => `Order ${v.orderId} created for customer ${v.customerId} total=$${v.amount}`,
  (v) => `Payment processed successfully for order ${v.orderId} amount=$${v.amount}`,
  (v) => `Email notification sent to ${v.email} for event ${v.event}`,
  (v) => `Inventory updated: product ${v.productId} quantity changed from ${v.oldQty} to ${v.newQty}`,
  (v) => `Search index rebuilt for ${v.docCount} documents in ${v.latency}ms`,
  (v) => `API rate limit check passed for client ${v.clientId} (${v.remaining} remaining)`,
  (v) => `Health check passed for service ${v.service} response_time=${v.latency}ms`,
  // warn
  (v) => `Slow query detected: ${v.latency}ms for SELECT FROM ${v.table} (threshold: 500ms)`,
  (v) => `Rate limit approaching for client ${v.clientId}: ${v.remaining} requests remaining`,
  (v) => `Deprecated API endpoint ${v.endpoint} called by client ${v.clientId}`,
  (v) => `Memory usage at ${v.pct}% of limit on instance ${v.instanceId}`,
  (v) => `Retry budget exhausted for downstream ${v.service} circuit will open`,
  (v) => `Session expiring soon for user ${v.userId} idle for ${v.idleMin} minutes`,
  // error
  (v) => `Failed to connect to database after ${v.attempt} attempts: ${v.errMsg}`,
  (v) => `Payment gateway timeout for order ${v.orderId} after ${v.latency}ms`,
  (v) => `Unhandled exception in ${v.service}: ${v.errMsg} at ${v.location}`,
  (v) => `Authentication failed for user ${v.userId}: invalid credentials from IP ${v.ip}`,
];

// LCG parameters (Numerical Recipes)
const LCG_A = 1664525n;
const LCG_C = 1013904223n;
const LCG_M = 2n ** 32n;

function makePrng(seed) {
  let state = BigInt(seed) & (LCG_M - 1n);
  return function next() {
    state = (LCG_A * state + LCG_C) & (LCG_M - 1n);
    return Number(state);
  };
}

function randInt(rng, min, max) {
  return min + (rng() % (max - min + 1));
}

function randFloat(rng, min, max) {
  return min + (rng() / 0xffffffff) * (max - min);
}

function randChoice(rng, arr) {
  return arr[rng() % arr.length];
}

function getSeverity(rng) {
  const roll = rng() % 100;
  if (roll < SEVERITY_THRESHOLDS[0]) return 'debug';
  if (roll < SEVERITY_THRESHOLDS[1]) return 'info';
  if (roll < SEVERITY_THRESHOLDS[2]) return 'warn';
  return 'error';
}

function makeVars(rng) {
  return {
    reqId: `req-${(rng() % 999999).toString().padStart(6, '0')}`,
    userId: `usr-${(rng() % 9999).toString().padStart(4, '0')}`,
    endpoint: randChoice(rng, ['/api/v1/users', '/api/v1/orders', '/api/v1/products', '/api/v2/search', '/health', '/metrics']),
    cacheKey: `cache:${randChoice(rng, ['user', 'product', 'session', 'rate'])}:${rng() % 10000}`,
    hit: rng() % 2 === 0,
    latency: randInt(rng, 1, 2000),
    table: randChoice(rng, ['users', 'orders', 'products', 'sessions', 'events', 'payments']),
    id: rng() % 1000000,
    active: randInt(rng, 0, 20),
    idle: randInt(rng, 0, 50),
    waiting: randInt(rng, 0, 10),
    bytes: randInt(rng, 100, 50000),
    attempt: randInt(rng, 1, 5),
    maxAttempts: 5,
    op: randChoice(rng, ['send-email', 'process-payment', 'update-inventory', 'sync-search']),
    jobName: randChoice(rng, ['cleanup-sessions', 'rebuild-index', 'send-digest', 'archive-logs']),
    startTime: `${randInt(rng, 0, 23).toString().padStart(2, '0')}:${randInt(rng, 0, 59).toString().padStart(2, '0')}`,
    params: `{"batch":${randInt(rng, 100, 1000)}}`,
    ip: `${randInt(rng, 1, 254)}.${randInt(rng, 0, 255)}.${randInt(rng, 0, 255)}.${randInt(rng, 1, 254)}`,
    orderId: `ord-${(rng() % 999999).toString().padStart(6, '0')}`,
    customerId: `cust-${(rng() % 9999).toString().padStart(4, '0')}`,
    amount: (randFloat(rng, 1, 9999)).toFixed(2),
    email: `user${rng() % 10000}@example.com`,
    event: randChoice(rng, ['order-created', 'payment-confirmed', 'shipment-dispatched', 'account-verified']),
    productId: `prod-${(rng() % 9999).toString().padStart(4, '0')}`,
    oldQty: randInt(rng, 0, 1000),
    newQty: randInt(rng, 0, 1000),
    docCount: randInt(rng, 1000, 500000),
    clientId: `client-${(rng() % 999).toString().padStart(3, '0')}`,
    remaining: randInt(rng, 0, 1000),
    service: randChoice(rng, SERVICES),
    pct: randInt(rng, 70, 99),
    instanceId: `i-${(rng() % 99999).toString(16).padStart(5, '0')}`,
    idleMin: randInt(rng, 25, 60),
    errMsg: randChoice(rng, [
      'connection refused',
      'timeout after 30s',
      'too many connections',
      'disk quota exceeded',
      'null pointer dereference',
      'invalid JSON payload',
    ]),
    location: `${randChoice(rng, ['handlers', 'middleware', 'services', 'models'])}.js:${randInt(rng, 1, 500)}`,
  };
}

/**
 * Generate all 100,000 rows as an array of objects.
 * Timestamps span 30 days ending at a fixed epoch so they're deterministic.
 */
export function generateRows(count = 100_000) {
  const rng = makePrng(42);
  // End time: 2024-01-30T00:00:00Z in ms
  const END_MS = 1706572800000;
  const START_MS = END_MS - 30 * 24 * 60 * 60 * 1000;
  const SPAN_MS = END_MS - START_MS;

  const rows = [];
  for (let i = 0; i < count; i++) {
    const tsMs = START_MS + (rng() / 0xffffffff) * SPAN_MS;
    const ts = new Date(tsMs).toISOString();
    const severity = getSeverity(rng);
    const service = randChoice(rng, SERVICES);
    const vars = makeVars(rng);

    // Pick template based on severity
    let templatePool;
    if (severity === 'debug') templatePool = MESSAGE_TEMPLATES.slice(0, 8);
    else if (severity === 'info') templatePool = MESSAGE_TEMPLATES.slice(8, 16);
    else if (severity === 'warn') templatePool = MESSAGE_TEMPLATES.slice(16, 22);
    else templatePool = MESSAGE_TEMPLATES.slice(22);

    const template = randChoice(rng, templatePool);
    const message = template(vars);

    rows.push({ ts, severity, service, message });
  }
  return rows;
}
