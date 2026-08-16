/**
 * Deterministic seed generator for 100,000 log entries.
 * Uses a simple LCG PRNG seeded at 42 for full reproducibility.
 */

const SEVERITIES = ['debug', 'info', 'warn', 'error'];
// Roughly 60/25/10/5 distribution
const SEVERITY_WEIGHTS = [60, 25, 10, 5];
const SEVERITY_CUM = [60, 85, 95, 100];

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

// Message templates with variable fragments
// Some terms are selective (rare), some non-selective (common)
const MESSAGE_TEMPLATES = [
  // debug
  (r) => `Cache lookup for key=${r.key} returned ${r.hit ? 'HIT' : 'MISS'} in ${r.ms}ms`,
  (r) => `DB query executed: SELECT * FROM ${r.table} WHERE id=${r.id} [${r.ms}ms]`,
  (r) => `Request received: ${r.method} ${r.path} from ${r.ip}`,
  (r) => `Session token validated for user_id=${r.userId}`,
  (r) => `Config reload triggered, ${r.count} keys updated`,
  (r) => `Health check passed for dependency=${r.dep}`,
  (r) => `Retry attempt ${r.attempt} of ${r.max} for operation=${r.op}`,
  (r) => `Queue depth=${r.depth} for topic=${r.topic}`,
  // info
  (r) => `User ${r.userId} logged in successfully from ${r.ip}`,
  (r) => `Order ${r.orderId} created for customer ${r.customerId}`,
  (r) => `Payment processed: amount=${r.amount} currency=${r.currency} txn=${r.txn}`,
  (r) => `Email notification sent to ${r.email} template=${r.template}`,
  (r) => `Inventory updated: sku=${r.sku} delta=${r.delta} new_stock=${r.stock}`,
  (r) => `Search query="${r.query}" returned ${r.hits} results in ${r.ms}ms`,
  (r) => `API rate limit: client=${r.client} remaining=${r.remaining} window=${r.window}s`,
  (r) => `Deployment completed: version=${r.version} service=${r.svc} region=${r.region}`,
  // warn
  (r) => `Slow query detected: ${r.ms}ms for SELECT on ${r.table} (threshold=500ms)`,
  (r) => `Memory usage at ${r.pct}% of limit on instance=${r.instance}`,
  (r) => `Deprecated API endpoint called: ${r.path} by client=${r.client}`,
  (r) => `Circuit breaker half-open for service=${r.dep} attempt=${r.attempt}`,
  (r) => `Token expiring soon for user_id=${r.userId} expires_in=${r.exp}s`,
  (r) => `Disk usage at ${r.pct}% on volume=${r.vol}`,
  // error
  (r) => `Database connection failed: host=${r.host} error="${r.err}"`,
  (r) => `Unhandled exception in handler=${r.handler}: ${r.err}`,
  (r) => `Payment declined: txn=${r.txn} reason="${r.reason}" customer=${r.customerId}`,
  (r) => `Authentication failed for user=${r.userId} reason="${r.reason}"`,
  (r) => `Service unavailable: ${r.dep} timeout after ${r.ms}ms`,
  (r) => `Data validation error: field=${r.field} value="${r.val}" constraint=${r.constraint}`,
];

// LCG PRNG - deterministic
function makePRNG(seed) {
  let s = seed >>> 0;
  return function () {
    s = Math.imul(1664525, s) + 1013904223;
    s = s >>> 0;
    return s / 0x100000000;
  };
}

function pickWeighted(rng, cumWeights) {
  const r = rng() * 100;
  for (let i = 0; i < cumWeights.length; i++) {
    if (r < cumWeights[i]) return i;
  }
  return cumWeights.length - 1;
}

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function randChoice(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function randIp(rng) {
  return `${randInt(rng, 10, 192)}.${randInt(rng, 0, 255)}.${randInt(rng, 0, 255)}.${randInt(rng, 1, 254)}`;
}

function randHex(rng, len) {
  let s = '';
  const chars = '0123456789abcdef';
  for (let i = 0; i < len; i++) s += chars[Math.floor(rng() * 16)];
  return s;
}

// Selective terms (rare) and non-selective terms (common) for substring search testing
const SELECTIVE_TERMS = ['CRITICAL_OVERFLOW', 'txn_rollback_forced', 'DEADLOCK_DETECTED', 'panic_recovery'];
const TABLES = ['users', 'orders', 'payments', 'sessions', 'inventory', 'events', 'logs', 'metrics'];
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD'];
const REGIONS = ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1'];
const ERRORS = [
  'connection refused',
  'timeout exceeded',
  'permission denied',
  'null pointer dereference',
  'out of memory',
  'disk full',
  'invalid certificate',
  'rate limit exceeded',
];
const REASONS = ['invalid_credentials', 'account_locked', 'token_expired', 'insufficient_funds', 'card_declined'];
const CONSTRAINTS = ['NOT NULL', 'UNIQUE', 'FOREIGN KEY', 'CHECK', 'PRIMARY KEY'];
const TOPICS = ['user-events', 'order-events', 'payment-events', 'notification-queue', 'analytics-stream'];
const DEPS = ['postgres', 'redis', 'elasticsearch', 'kafka', 's3', 'smtp-relay', 'cdn'];
const OPS = ['send_email', 'charge_card', 'update_inventory', 'sync_cache', 'publish_event'];
const TEMPLATES = ['welcome', 'password_reset', 'order_confirm', 'invoice', 'alert'];

export function generateRows(count = 100000) {
  const rng = makePRNG(42);

  // Span 30 days ending at a fixed point for determinism
  const END_TS = new Date('2024-01-30T23:59:59Z').getTime();
  const START_TS = END_TS - 30 * 24 * 60 * 60 * 1000;

  const rows = [];

  for (let i = 0; i < count; i++) {
    const sevIdx = pickWeighted(rng, SEVERITY_CUM);
    const severity = SEVERITIES[sevIdx];
    const service = randChoice(rng, SERVICES);

    // Timestamp: random within 30-day window
    const ts = new Date(START_TS + rng() * (END_TS - START_TS));

    // Build template vars
    const vars = {
      key: `${randChoice(rng, ['user', 'session', 'product', 'order'])}:${randInt(rng, 1, 99999)}`,
      hit: rng() > 0.4,
      ms: randInt(rng, 1, 2000),
      table: randChoice(rng, TABLES),
      id: randInt(rng, 1, 999999),
      method: randChoice(rng, METHODS),
      path: `/${randChoice(rng, ['api', 'v1', 'v2'])}/${randChoice(rng, ['users', 'orders', 'products', 'auth'])}/${randInt(rng, 1, 9999)}`,
      ip: randIp(rng),
      userId: randInt(rng, 1000, 99999),
      count: randInt(rng, 1, 50),
      dep: randChoice(rng, DEPS),
      attempt: randInt(rng, 1, 5),
      max: 5,
      op: randChoice(rng, OPS),
      depth: randInt(rng, 0, 10000),
      topic: randChoice(rng, TOPICS),
      orderId: `ORD-${randHex(rng, 8).toUpperCase()}`,
      customerId: randInt(rng, 1000, 99999),
      amount: (randInt(rng, 100, 100000) / 100).toFixed(2),
      currency: randChoice(rng, CURRENCIES),
      txn: `TXN-${randHex(rng, 12).toUpperCase()}`,
      email: `user${randInt(rng, 1, 99999)}@example.com`,
      template: randChoice(rng, TEMPLATES),
      sku: `SKU-${randInt(rng, 10000, 99999)}`,
      delta: randInt(rng, -100, 100),
      stock: randInt(rng, 0, 10000),
      query: randChoice(rng, ['laptop', 'phone', 'tablet', 'headphones', 'keyboard', 'monitor']),
      hits: randInt(rng, 0, 5000),
      client: `client-${randHex(rng, 6)}`,
      remaining: randInt(rng, 0, 1000),
      window: randInt(rng, 60, 3600),
      version: `${randInt(rng, 1, 5)}.${randInt(rng, 0, 20)}.${randInt(rng, 0, 99)}`,
      svc: service,
      region: randChoice(rng, REGIONS),
      pct: randInt(rng, 70, 99),
      instance: `i-${randHex(rng, 8)}`,
      exp: randInt(rng, 30, 3600),
      vol: `/dev/sd${randChoice(rng, ['a', 'b', 'c', 'd'])}1`,
      host: `db-${randInt(rng, 1, 5)}.internal`,
      err: randChoice(rng, ERRORS),
      handler: `${randChoice(rng, ['handleRequest', 'processPayment', 'updateUser', 'sendNotification', 'syncInventory'])}`,
      reason: randChoice(rng, REASONS),
      field: randChoice(rng, ['email', 'phone', 'amount', 'user_id', 'order_id']),
      val: `${randHex(rng, 4)}`,
      constraint: randChoice(rng, CONSTRAINTS),
    };

    // Occasionally inject selective terms for search testing
    let message;
    const templateIdx = Math.floor(rng() * MESSAGE_TEMPLATES.length);
    message = MESSAGE_TEMPLATES[templateIdx](vars);

    // ~0.1% chance to inject a selective term
    if (rng() < 0.001) {
      message += ` [${randChoice(rng, SELECTIVE_TERMS)}]`;
    }

    rows.push({
      ts: ts.toISOString(),
      severity,
      service,
      message,
    });
  }

  return rows;
}
