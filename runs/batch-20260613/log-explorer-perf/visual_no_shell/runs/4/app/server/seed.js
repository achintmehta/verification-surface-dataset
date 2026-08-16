/**
 * Deterministic seed of exactly 100,000 log entries.
 * Uses a simple LCG-based PRNG for determinism without external deps.
 */

const TOTAL_ROWS = 100_000;
const BATCH_SIZE = 2_000;

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

const SEVERITIES = ['debug', 'info', 'warn', 'error'];
// Roughly 60/25/10/5 distribution
const SEVERITY_WEIGHTS = [60, 25, 10, 5];
const SEVERITY_CUMULATIVE = [60, 85, 95, 100];

// Message templates with variable fragments
const MESSAGE_TEMPLATES = [
  // debug
  (r) => `Processing request ${r.reqId} for user ${r.userId} on endpoint ${r.endpoint}`,
  (r) => `Cache lookup for key ${r.cacheKey} returned ${r.cacheResult}`,
  (r) => `DB query executed in ${r.duration}ms: SELECT * FROM ${r.table} WHERE id=${r.rowId}`,
  (r) => `Heartbeat check passed for node ${r.nodeId} at region ${r.region}`,
  (r) => `Config reload triggered by signal, version ${r.version}`,
  (r) => `Span ${r.spanId} started for trace ${r.traceId}`,
  (r) => `Worker ${r.workerId} picked up job ${r.jobId} from queue ${r.queue}`,
  (r) => `Token validation succeeded for session ${r.sessionId}`,
  // info
  (r) => `User ${r.userId} logged in from IP ${r.ip}`,
  (r) => `Order ${r.orderId} created successfully for customer ${r.customerId}`,
  (r) => `Payment ${r.paymentId} processed via ${r.provider} in ${r.duration}ms`,
  (r) => `Inventory updated: item ${r.itemId} quantity changed to ${r.quantity}`,
  (r) => `Notification sent to user ${r.userId} via ${r.channel}`,
  (r) => `Service ${r.service} started successfully on port ${r.port}`,
  (r) => `Scheduled job ${r.jobName} completed in ${r.duration}ms`,
  (r) => `API rate limit: user ${r.userId} used ${r.used}/${r.limit} requests`,
  // warn
  (r) => `Slow query detected: ${r.duration}ms for SELECT on ${r.table}`,
  (r) => `Retry attempt ${r.attempt}/${r.maxAttempts} for request ${r.reqId}`,
  (r) => `Memory usage at ${r.memPct}% on node ${r.nodeId}`,
  (r) => `Deprecated endpoint ${r.endpoint} called by user ${r.userId}`,
  (r) => `Circuit breaker half-open for service ${r.service}`,
  (r) => `Cache miss rate elevated: ${r.missRate}% over last ${r.window}s`,
  // error
  (r) => `Failed to connect to database after ${r.attempt} retries: ${r.errMsg}`,
  (r) => `Unhandled exception in ${r.service}: ${r.errMsg} at ${r.file}:${r.line}`,
  (r) => `Payment ${r.paymentId} failed: ${r.errMsg}`,
  (r) => `Authentication failed for user ${r.userId}: invalid credentials`,
  (r) => `Timeout after ${r.duration}ms waiting for ${r.service} response`,
  (r) => `Data corruption detected in record ${r.rowId} of table ${r.table}`,
];

// Simple LCG PRNG for determinism
class LCG {
  constructor(seed) {
    this.state = seed >>> 0;
  }
  next() {
    // LCG parameters from Numerical Recipes
    this.state = ((Math.imul(1664525, this.state) + 1013904223) >>> 0);
    return this.state / 0x100000000;
  }
  nextInt(max) {
    return Math.floor(this.next() * max);
  }
  nextIntRange(min, max) {
    return min + this.nextInt(max - min);
  }
}

function pickSeverity(rng) {
  const roll = rng.nextInt(100);
  for (let i = 0; i < SEVERITY_CUMULATIVE.length; i++) {
    if (roll < SEVERITY_CUMULATIVE[i]) return SEVERITIES[i];
  }
  return 'info';
}

function generateVars(rng) {
  const reqId = `req-${(rng.nextInt(0xFFFFFF)).toString(16).padStart(6, '0')}`;
  const userId = `usr-${rng.nextInt(10000).toString().padStart(5, '0')}`;
  const orderId = `ord-${rng.nextInt(100000).toString().padStart(6, '0')}`;
  const paymentId = `pay-${rng.nextInt(100000).toString().padStart(6, '0')}`;
  const customerId = `cust-${rng.nextInt(50000).toString().padStart(5, '0')}`;
  const itemId = `item-${rng.nextInt(5000).toString().padStart(4, '0')}`;
  const nodeId = `node-${rng.nextInt(32).toString().padStart(2, '0')}`;
  const workerId = `worker-${rng.nextInt(16)}`;
  const jobId = `job-${rng.nextInt(1000000).toString().padStart(7, '0')}`;
  const spanId = (rng.nextInt(0xFFFFFFFF)).toString(16).padStart(8, '0');
  const traceId = (rng.nextInt(0xFFFFFFFF)).toString(16).padStart(8, '0') + (rng.nextInt(0xFFFFFFFF)).toString(16).padStart(8, '0');
  const sessionId = (rng.nextInt(0xFFFFFFFF)).toString(16).padStart(8, '0');
  const cacheKey = `cache:${['user', 'order', 'product', 'session'][rng.nextInt(4)]}:${rng.nextInt(10000)}`;
  const cacheResult = ['HIT', 'MISS', 'STALE'][rng.nextInt(3)];
  const duration = rng.nextIntRange(1, 5000);
  const table = ['users', 'orders', 'payments', 'inventory', 'sessions', 'events'][rng.nextInt(6)];
  const rowId = rng.nextInt(1000000);
  const region = ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1'][rng.nextInt(4)];
  const version = `${rng.nextInt(5)}.${rng.nextInt(20)}.${rng.nextInt(100)}`;
  const queue = ['high-priority', 'default', 'low-priority', 'batch'][rng.nextInt(4)];
  const ip = `${rng.nextInt(256)}.${rng.nextInt(256)}.${rng.nextInt(256)}.${rng.nextInt(256)}`;
  const provider = ['stripe', 'paypal', 'braintree', 'adyen'][rng.nextInt(4)];
  const quantity = rng.nextInt(10000);
  const channel = ['email', 'sms', 'push', 'webhook'][rng.nextInt(4)];
  const port = [3000, 3001, 8080, 8443, 9000][rng.nextInt(5)];
  const jobName = ['cleanup', 'report', 'sync', 'backup', 'index'][rng.nextInt(5)];
  const used = rng.nextInt(1000);
  const limit = 1000;
  const attempt = rng.nextIntRange(1, 6);
  const maxAttempts = 5;
  const memPct = rng.nextIntRange(70, 100);
  const endpoint = ['/api/users', '/api/orders', '/api/payments', '/api/inventory', '/health'][rng.nextInt(5)];
  const missRate = rng.nextIntRange(10, 80);
  const window = [60, 300, 900][rng.nextInt(3)];
  const errMsgs = [
    'connection refused',
    'timeout exceeded',
    'null pointer exception',
    'disk full',
    'permission denied',
    'invalid token',
    'rate limit exceeded',
    'service unavailable',
  ];
  const errMsg = errMsgs[rng.nextInt(errMsgs.length)];
  const file = [`src/handlers/${table}.js`, `src/services/${table}Service.js`, `src/db/queries.js`][rng.nextInt(3)];
  const line = rng.nextIntRange(10, 500);
  const service = SERVICES[rng.nextInt(SERVICES.length)];

  return {
    reqId, userId, orderId, paymentId, customerId, itemId, nodeId, workerId,
    jobId, spanId, traceId, sessionId, cacheKey, cacheResult, duration, table,
    rowId, region, version, queue, ip, provider, quantity, channel, port,
    jobName, used, limit, attempt, maxAttempts, memPct, endpoint, missRate,
    window, errMsg, file, line, service,
  };
}

export async function seedDatabase(db) {
  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*) as cnt FROM logs');
  const existingCount = parseInt(countResult.rows[0].cnt, 10);

  if (existingCount >= TOTAL_ROWS) {
    console.log(`Database already seeded with ${existingCount} rows. Skipping seed.`);
    return;
  }

  if (existingCount > 0) {
    console.log(`Partial seed detected (${existingCount} rows). Clearing and reseeding...`);
    await db.exec('DELETE FROM logs');
  }

  console.log(`Seeding ${TOTAL_ROWS} log entries in batches of ${BATCH_SIZE}...`);
  const startTime = Date.now();

  const rng = new LCG(42); // Fixed seed for determinism

  // Time range: 30 days ending at a fixed point
  const END_TS = new Date('2024-01-31T23:59:59Z').getTime();
  const START_TS = END_TS - 30 * 24 * 60 * 60 * 1000;
  const TIME_RANGE = END_TS - START_TS;

  let inserted = 0;

  while (inserted < TOTAL_ROWS) {
    const batchSize = Math.min(BATCH_SIZE, TOTAL_ROWS - inserted);
    const rows = [];

    for (let i = 0; i < batchSize; i++) {
      const id = inserted + i + 1;
      const tsMs = START_TS + Math.floor(rng.next() * TIME_RANGE);
      const ts = new Date(tsMs).toISOString().replace('T', ' ').replace('Z', '');
      const severity = pickSeverity(rng);
      const service = SERVICES[rng.nextInt(SERVICES.length)];
      const vars = generateVars(rng);
      const templateIdx = rng.nextInt(MESSAGE_TEMPLATES.length);
      const message = MESSAGE_TEMPLATES[templateIdx](vars);

      rows.push({ id, ts, severity, service, message });
    }

    // Build batch insert
    const valuePlaceholders = rows.map((_, i) => {
      const base = i * 5;
      return `($${base + 1}, $${base + 2}::timestamp, $${base + 3}, $${base + 4}, $${base + 5})`;
    }).join(', ');

    const params = [];
    for (const row of rows) {
      params.push(row.id, row.ts, row.severity, row.service, row.message);
    }

    await db.query(
      `INSERT INTO logs (id, ts, severity, service, message) VALUES ${valuePlaceholders}`,
      params
    );

    inserted += batchSize;

    if (inserted % 10000 === 0 || inserted === TOTAL_ROWS) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  Seeded ${inserted}/${TOTAL_ROWS} rows (${elapsed}s elapsed)`);
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Seeding complete: ${TOTAL_ROWS} rows in ${totalTime}s`);
}
