/**
 * Deterministic seed of exactly 100,000 log entries.
 * Uses a simple LCG PRNG seeded at 42 for full reproducibility.
 * Rows span 30 days across 8 services.
 * Severity distribution: ~60% debug, ~25% info, ~10% warn, ~5% error
 * Messages drawn from templates with variable fragments for selective/non-selective substring search.
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

const SEVERITIES = ['debug', 'debug', 'debug', 'debug', 'debug', 'debug', 'info', 'info', 'info', 'warn', 'error'];
// 6/11 debug ≈ 54.5%, 3/11 info ≈ 27.3%, 1/11 warn ≈ 9.1%, 1/11 error ≈ 9.1%
// Adjust to hit ~60/25/10/5:
const SEVERITY_WEIGHTS = [
  { sev: 'debug', weight: 60 },
  { sev: 'info',  weight: 25 },
  { sev: 'warn',  weight: 10 },
  { sev: 'error', weight: 5  },
];
const SEVERITY_TOTAL = 100;

// Message templates with variable slots
// Some terms are selective (rare), some non-selective (common)
const MESSAGE_TEMPLATES = [
  // debug templates
  (r) => `Processing request ${r.reqId} for user ${r.userId} on endpoint ${r.endpoint}`,
  (r) => `Cache ${r.cacheOp} for key ${r.cacheKey} in ${r.duration}ms`,
  (r) => `Database query executed in ${r.duration}ms rows_returned=${r.rows}`,
  (r) => `Connection pool status: active=${r.active} idle=${r.idle} waiting=${r.waiting}`,
  (r) => `Heartbeat check passed for node ${r.nodeId} latency=${r.latency}ms`,
  (r) => `Config reload triggered by signal ${r.signal} version=${r.version}`,
  (r) => `Scheduled job ${r.jobName} started at ${r.startTime}`,
  (r) => `Token validation succeeded for session ${r.sessionId}`,
  (r) => `Retry attempt ${r.attempt} of ${r.maxAttempts} for operation ${r.operation}`,
  (r) => `Metric recorded: ${r.metricName}=${r.metricValue} tags=${r.tags}`,
  // info templates
  (r) => `User ${r.userId} logged in from IP ${r.ip} using ${r.authMethod}`,
  (r) => `Order ${r.orderId} created for customer ${r.customerId} total=${r.amount}`,
  (r) => `Payment ${r.paymentId} processed successfully amount=${r.amount} currency=${r.currency}`,
  (r) => `Notification sent to ${r.recipient} via ${r.channel} template=${r.template}`,
  (r) => `Inventory updated for SKU ${r.sku} quantity=${r.quantity} warehouse=${r.warehouse}`,
  (r) => `Search query "${r.query}" returned ${r.resultCount} results in ${r.duration}ms`,
  (r) => `Service ${r.serviceName} started successfully version=${r.version} pid=${r.pid}`,
  (r) => `Deployment ${r.deployId} completed for environment ${r.env}`,
  // warn templates
  (r) => `Slow query detected: ${r.duration}ms threshold=${r.threshold}ms query_hash=${r.queryHash}`,
  (r) => `Rate limit approaching for client ${r.clientId} usage=${r.usage}% limit=${r.limit}`,
  (r) => `Memory usage high: ${r.memUsage}MB threshold=${r.threshold}MB on node ${r.nodeId}`,
  (r) => `Deprecated API endpoint ${r.endpoint} called by ${r.clientId} migrate_by=${r.deadline}`,
  (r) => `Circuit breaker half-open for service ${r.targetService} attempt=${r.attempt}`,
  // error templates
  (r) => `Failed to connect to database host=${r.host} port=${r.port} error="${r.errorMsg}"`,
  (r) => `Unhandled exception in ${r.handler} error="${r.errorMsg}" stack_trace_id=${r.traceId}`,
  (r) => `Payment ${r.paymentId} failed for customer ${r.customerId} reason="${r.errorMsg}"`,
  (r) => `Authentication failed for user ${r.userId} from IP ${r.ip} reason="${r.errorMsg}"`,
];

// Variable fragment pools
const ENDPOINTS = ['/api/users', '/api/orders', '/api/products', '/api/search', '/api/auth', '/api/payments', '/api/inventory', '/api/notifications'];
const AUTH_METHODS = ['oauth2', 'jwt', 'api-key', 'saml', 'basic'];
const CHANNELS = ['email', 'sms', 'push', 'webhook', 'slack'];
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD'];
const ENVS = ['production', 'staging', 'canary'];
const CACHE_OPS = ['hit', 'miss', 'evict', 'set', 'delete'];
const ERROR_MSGS = [
  'connection refused',
  'timeout exceeded',
  'permission denied',
  'invalid token',
  'resource not found',
  'quota exceeded',
  'internal server error',
  'service unavailable',
];
const WAREHOUSES = ['WH-EAST', 'WH-WEST', 'WH-CENTRAL', 'WH-NORTH'];
const METRIC_NAMES = ['request_duration_ms', 'queue_depth', 'cache_hit_ratio', 'error_rate', 'throughput_rps'];

// Simple LCG PRNG (deterministic)
class LCG {
  constructor(seed) {
    this.state = seed >>> 0;
  }
  next() {
    // LCG parameters from Numerical Recipes
    this.state = (Math.imul(1664525, this.state) + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }
  nextInt(max) {
    return Math.floor(this.next() * max);
  }
  pick(arr) {
    return arr[this.nextInt(arr.length)];
  }
  nextFloat(min, max) {
    return min + this.next() * (max - min);
  }
}

function pickSeverity(rng) {
  const roll = rng.nextInt(SEVERITY_TOTAL);
  let cumulative = 0;
  for (const { sev, weight } of SEVERITY_WEIGHTS) {
    cumulative += weight;
    if (roll < cumulative) return sev;
  }
  return 'debug';
}

function buildVars(rng, i) {
  const userId = `u${rng.nextInt(10000).toString().padStart(5, '0')}`;
  const orderId = `ord-${rng.nextInt(999999).toString().padStart(6, '0')}`;
  const paymentId = `pay-${rng.nextInt(999999).toString().padStart(6, '0')}`;
  const customerId = `cust-${rng.nextInt(50000).toString().padStart(5, '0')}`;
  const sessionId = `sess-${(i * 7919 + 12345).toString(16).padStart(8, '0')}`;
  const traceId = `trace-${(i * 6271 + 98765).toString(16).padStart(10, '0')}`;
  const reqId = `req-${i.toString().padStart(8, '0')}`;
  const ip = `${rng.nextInt(256)}.${rng.nextInt(256)}.${rng.nextInt(256)}.${rng.nextInt(256)}`;
  const duration = rng.nextInt(5000);
  const rows = rng.nextInt(10000);
  const active = rng.nextInt(50);
  const idle = rng.nextInt(50);
  const waiting = rng.nextInt(10);
  const nodeId = `node-${rng.nextInt(16).toString().padStart(2, '0')}`;
  const latency = rng.nextInt(100);
  const signal = rng.pick(['SIGHUP', 'SIGUSR1', 'SIGUSR2']);
  const version = `${rng.nextInt(5)}.${rng.nextInt(20)}.${rng.nextInt(100)}`;
  const jobName = rng.pick(['cleanup', 'report-gen', 'cache-warm', 'index-rebuild', 'backup', 'sync']);
  const startTime = new Date(Date.now() - rng.nextInt(86400000)).toISOString();
  const attempt = rng.nextInt(5) + 1;
  const maxAttempts = 5;
  const operation = rng.pick(['db-write', 'cache-set', 'api-call', 'file-upload', 'email-send']);
  const metricName = rng.pick(METRIC_NAMES);
  const metricValue = rng.nextFloat(0, 1000).toFixed(2);
  const tags = `service=${rng.pick(SERVICES)},env=${rng.pick(ENVS)}`;
  const authMethod = rng.pick(AUTH_METHODS);
  const amount = rng.nextFloat(1, 10000).toFixed(2);
  const currency = rng.pick(CURRENCIES);
  const recipient = `user${rng.nextInt(10000)}@example.com`;
  const channel = rng.pick(CHANNELS);
  const template = rng.pick(['welcome', 'reset-password', 'order-confirm', 'invoice', 'alert']);
  const sku = `SKU-${rng.nextInt(99999).toString().padStart(5, '0')}`;
  const quantity = rng.nextInt(1000);
  const warehouse = rng.pick(WAREHOUSES);
  const query = rng.pick(['laptop', 'phone', 'tablet', 'headphones', 'keyboard', 'monitor', 'cable', 'charger']);
  const resultCount = rng.nextInt(500);
  const serviceName = rng.pick(SERVICES);
  const pid = rng.nextInt(65535) + 1000;
  const deployId = `deploy-${rng.nextInt(9999).toString().padStart(4, '0')}`;
  const env = rng.pick(ENVS);
  const threshold = rng.nextInt(5000);
  const queryHash = `qh${(rng.nextInt(0xffffff)).toString(16).padStart(6, '0')}`;
  const clientId = `client-${rng.nextInt(1000).toString().padStart(3, '0')}`;
  const usage = rng.nextInt(100);
  const limit = rng.pick([100, 500, 1000, 5000]);
  const memUsage = rng.nextInt(16384);
  const endpoint = rng.pick(ENDPOINTS);
  const deadline = `2024-${(rng.nextInt(12) + 1).toString().padStart(2, '0')}-01`;
  const targetService = rng.pick(SERVICES);
  const host = rng.pick(['db-primary', 'db-replica-1', 'db-replica-2', 'cache-01', 'cache-02']);
  const port = rng.pick([5432, 6379, 27017, 3306]);
  const errorMsg = rng.pick(ERROR_MSGS);
  const handler = rng.pick(['RequestHandler', 'PaymentProcessor', 'AuthMiddleware', 'DataPipeline', 'EventConsumer']);
  const cacheKey = `${rng.pick(['user', 'product', 'session', 'config'])}:${rng.nextInt(99999)}`;
  const cacheOp = rng.pick(CACHE_OPS);

  return {
    userId, orderId, paymentId, customerId, sessionId, traceId, reqId, ip,
    duration, rows, active, idle, waiting, nodeId, latency, signal, version,
    jobName, startTime, attempt, maxAttempts, operation, metricName, metricValue,
    tags, authMethod, amount, currency, recipient, channel, template, sku,
    quantity, warehouse, query, resultCount, serviceName, pid, deployId, env,
    threshold, queryHash, clientId, usage, limit, memUsage, endpoint, deadline,
    targetService, host, port, errorMsg, handler, cacheKey, cacheOp,
  };
}

function pickTemplate(rng, severity) {
  // Map severity to template index ranges
  const debugTemplates = MESSAGE_TEMPLATES.slice(0, 10);
  const infoTemplates = MESSAGE_TEMPLATES.slice(10, 18);
  const warnTemplates = MESSAGE_TEMPLATES.slice(18, 23);
  const errorTemplates = MESSAGE_TEMPLATES.slice(23);

  switch (severity) {
    case 'debug': return rng.pick(debugTemplates);
    case 'info':  return rng.pick(infoTemplates);
    case 'warn':  return rng.pick(warnTemplates);
    case 'error': return rng.pick(errorTemplates);
    default:      return rng.pick(debugTemplates);
  }
}

export async function seedLogs(db) {
  const TOTAL = 100000;
  const BATCH_SIZE = 1000;
  const rng = new LCG(42);

  // Time range: 30 days ending now
  const endTime = new Date('2024-01-30T23:59:59Z').getTime();
  const startTime = new Date('2023-12-31T00:00:00Z').getTime();
  const timeRange = endTime - startTime;

  // Pre-generate all timestamps and sort them for realistic ordering
  // We'll generate in batches to avoid memory issues
  console.log('Generating log entries in batches...');

  // Generate all rows data first (timestamps need to be spread across 30 days)
  // We'll use the row index to deterministically assign timestamps
  const rows = [];
  for (let i = 0; i < TOTAL; i++) {
    // Deterministic timestamp: spread evenly with small jitter
    const baseOffset = (i / TOTAL) * timeRange;
    const jitter = rng.next() * (timeRange / TOTAL) * 2;
    const ts = new Date(startTime + baseOffset + jitter - (timeRange / TOTAL));
    const severity = pickSeverity(rng);
    const service = rng.pick(SERVICES);
    const vars = buildVars(rng, i);
    const template = pickTemplate(rng, severity);
    const message = template(vars);
    rows.push({ id: i + 1, ts: ts.toISOString(), severity, service, message });
  }

  // Insert in batches
  for (let batchStart = 0; batchStart < TOTAL; batchStart += BATCH_SIZE) {
    const batch = rows.slice(batchStart, batchStart + BATCH_SIZE);
    
    // Build a multi-row INSERT
    const values = batch.map((row, idx) => {
      const paramBase = idx * 5;
      return `($${paramBase + 1}, $${paramBase + 2}::timestamptz, $${paramBase + 3}, $${paramBase + 4}, $${paramBase + 5})`;
    }).join(',\n');

    const params = batch.flatMap(row => [row.id, row.ts, row.severity, row.service, row.message]);

    await db.query(
      `INSERT INTO logs (id, ts, severity, service, message) VALUES ${values} ON CONFLICT (id) DO NOTHING`,
      params
    );

    if ((batchStart / BATCH_SIZE + 1) % 10 === 0) {
      console.log(`  Inserted ${batchStart + BATCH_SIZE} / ${TOTAL} rows...`);
    }
  }

  console.log('All rows inserted.');
}
