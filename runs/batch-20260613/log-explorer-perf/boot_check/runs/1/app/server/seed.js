// Deterministic seed for 100,000 log entries
// Uses a simple LCG PRNG for reproducibility

const TOTAL_ROWS = 100_000;
const BATCH_SIZE = 2_000;

const SERVICES = [
  'api-gateway',
  'auth-service',
  'user-service',
  'order-service',
  'payment-service',
  'inventory-service',
  'notification-service',
  'analytics-service',
];

// Severity distribution: ~60% debug, ~25% info, ~10% warn, ~5% error
const SEVERITY_WEIGHTS = [
  { severity: 'debug', weight: 60 },
  { severity: 'info',  weight: 25 },
  { severity: 'warn',  weight: 10 },
  { severity: 'error', weight: 5  },
];

// Build cumulative weights
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
  // debug templates
  (r) => `Processing request ${r.reqId} for user ${r.userId} on endpoint ${r.endpoint}`,
  (r) => `Cache ${r.cacheResult} for key ${r.cacheKey} in ${r.duration}ms`,
  (r) => `Database query executed in ${r.duration}ms rows_returned=${r.rows}`,
  (r) => `Heartbeat check passed for service ${r.service} instance ${r.instance}`,
  (r) => `Config loaded: feature_flag=${r.flag} value=${r.flagValue}`,
  (r) => `Session ${r.sessionId} refreshed token expiry extended by ${r.duration}s`,
  (r) => `Retry attempt ${r.attempt} of ${r.maxAttempts} for operation ${r.op}`,
  (r) => `Queue depth=${r.depth} consumer_lag=${r.lag}ms topic=${r.topic}`,
  // info templates
  (r) => `User ${r.userId} logged in from ${r.ip} using ${r.authMethod}`,
  (r) => `Order ${r.orderId} created for user ${r.userId} total=${r.amount}`,
  (r) => `Payment ${r.paymentId} processed successfully amount=${r.amount} method=${r.payMethod}`,
  (r) => `Inventory updated item=${r.itemId} delta=${r.delta} new_stock=${r.stock}`,
  (r) => `Notification sent to ${r.userId} via ${r.channel} template=${r.template}`,
  (r) => `Service ${r.service} started successfully version=${r.version} port=${r.port}`,
  (r) => `Scheduled job ${r.job} completed in ${r.duration}ms processed=${r.rows} records`,
  (r) => `API rate limit check passed for client ${r.clientId} remaining=${r.remaining}`,
  // warn templates
  (r) => `Slow query detected duration=${r.duration}ms threshold=500ms query_hash=${r.hash}`,
  (r) => `Memory usage high: ${r.memPct}% used heap=${r.heap}MB`,
  (r) => `Retry limit approaching attempt=${r.attempt} max=${r.maxAttempts} op=${r.op}`,
  (r) => `Deprecated endpoint called: ${r.endpoint} by client ${r.clientId}`,
  (r) => `Connection pool exhausted waiting=${r.waiting} pool_size=${r.poolSize}`,
  (r) => `Cache miss rate elevated: ${r.missRate}% over last ${r.window}s`,
  // error templates
  (r) => `Payment ${r.paymentId} failed: ${r.errorMsg} amount=${r.amount}`,
  (r) => `Database connection error: ${r.errorMsg} host=${r.dbHost} attempt=${r.attempt}`,
  (r) => `Unhandled exception in ${r.service}: ${r.errorMsg} stack_trace_id=${r.traceId}`,
  (r) => `Authentication failed for user ${r.userId} reason=${r.errorMsg} ip=${r.ip}`,
];

// Template index ranges by severity
const TEMPLATE_RANGES = {
  debug: [0, 7],
  info:  [8, 15],
  warn:  [16, 21],
  error: [22, 25],
};

// Variable fragments
const ENDPOINTS = ['/api/users', '/api/orders', '/api/payments', '/api/inventory', '/api/auth', '/api/search', '/api/reports', '/health'];
const AUTH_METHODS = ['password', 'oauth2', 'saml', 'api-key', 'mfa'];
const CHANNELS = ['email', 'sms', 'push', 'webhook', 'slack'];
const PAY_METHODS = ['credit_card', 'debit_card', 'paypal', 'bank_transfer', 'crypto'];
const ERROR_MSGS = [
  'connection timeout',
  'insufficient funds',
  'invalid credentials',
  'service unavailable',
  'rate limit exceeded',
  'disk quota exceeded',
  'null pointer exception',
  'deadlock detected',
];
const TOPICS = ['orders', 'payments', 'notifications', 'analytics', 'audit-log', 'user-events'];
const JOBS = ['cleanup-expired-sessions', 'aggregate-daily-stats', 'send-digest-emails', 'reindex-search', 'backup-database'];
const FLAGS = ['new-checkout-flow', 'dark-mode', 'beta-api', 'experimental-cache', 'ab-test-pricing'];
const DB_HOSTS = ['db-primary-01', 'db-replica-02', 'db-replica-03'];

// Simple LCG PRNG (deterministic)
class LCG {
  constructor(seed) {
    this.state = BigInt(seed);
    this.a = 1664525n;
    this.c = 1013904223n;
    this.m = 2n ** 32n;
  }

  next() {
    this.state = (this.a * this.state + this.c) % this.m;
    return Number(this.state);
  }

  // Returns float in [0, 1)
  nextFloat() {
    return this.next() / 4294967296;
  }

  // Returns integer in [0, max)
  nextInt(max) {
    return Math.floor(this.nextFloat() * max);
  }

  // Returns integer in [min, max]
  nextRange(min, max) {
    return min + this.nextInt(max - min + 1);
  }

  pick(arr) {
    return arr[this.nextInt(arr.length)];
  }
}

function pickSeverity(rng) {
  const roll = rng.nextInt(SEVERITY_TOTAL);
  for (const { severity, cum } of SEVERITY_CUM) {
    if (roll < cum) return severity;
  }
  return 'debug';
}

function generateRow(rng, id, baseTs) {
  const severity = pickSeverity(rng);
  const service = rng.pick(SERVICES);

  // Pick template for this severity
  const [tMin, tMax] = TEMPLATE_RANGES[severity];
  const templateIdx = tMin + rng.nextInt(tMax - tMin + 1);
  const template = MESSAGE_TEMPLATES[templateIdx];

  // Generate variable fragments
  const vars = {
    reqId:      `req-${rng.nextInt(999999).toString(16).padStart(6, '0')}`,
    userId:     `usr-${rng.nextInt(9999).toString().padStart(4, '0')}`,
    endpoint:   rng.pick(ENDPOINTS),
    cacheResult: rng.nextFloat() > 0.3 ? 'HIT' : 'MISS',
    cacheKey:   `cache:${rng.pick(['user', 'order', 'product', 'session'])}:${rng.nextInt(9999)}`,
    duration:   rng.nextRange(1, 2000),
    rows:       rng.nextRange(0, 5000),
    instance:   `i-${rng.nextInt(999).toString().padStart(3, '0')}`,
    flag:       rng.pick(FLAGS),
    flagValue:  rng.nextFloat() > 0.5 ? 'true' : 'false',
    sessionId:  `sess-${rng.nextInt(999999).toString(16).padStart(6, '0')}`,
    attempt:    rng.nextRange(1, 5),
    maxAttempts: 5,
    op:         `${rng.pick(['fetch', 'write', 'delete', 'update'])}-${rng.pick(['user', 'order', 'payment'])}`,
    depth:      rng.nextRange(0, 10000),
    lag:        rng.nextRange(0, 5000),
    topic:      rng.pick(TOPICS),
    ip:         `${rng.nextRange(1,254)}.${rng.nextRange(0,255)}.${rng.nextRange(0,255)}.${rng.nextRange(1,254)}`,
    authMethod: rng.pick(AUTH_METHODS),
    orderId:    `ord-${rng.nextInt(999999).toString(16).padStart(6, '0')}`,
    amount:     (rng.nextRange(100, 99999) / 100).toFixed(2),
    paymentId:  `pay-${rng.nextInt(999999).toString(16).padStart(6, '0')}`,
    payMethod:  rng.pick(PAY_METHODS),
    itemId:     `item-${rng.nextInt(9999).toString().padStart(4, '0')}`,
    delta:      rng.nextRange(-100, 100),
    stock:      rng.nextRange(0, 10000),
    channel:    rng.pick(CHANNELS),
    template:   `tmpl-${rng.nextRange(1, 50)}`,
    version:    `${rng.nextRange(1,5)}.${rng.nextRange(0,20)}.${rng.nextRange(0,99)}`,
    port:       rng.nextRange(3000, 9999),
    job:        rng.pick(JOBS),
    clientId:   `client-${rng.nextInt(999).toString().padStart(3, '0')}`,
    remaining:  rng.nextRange(0, 1000),
    hash:       rng.nextInt(0xFFFFFF).toString(16).padStart(6, '0'),
    memPct:     rng.nextRange(70, 99),
    heap:       rng.nextRange(256, 4096),
    waiting:    rng.nextRange(1, 50),
    poolSize:   rng.nextRange(10, 100),
    missRate:   rng.nextRange(20, 80),
    window:     rng.nextRange(60, 3600),
    errorMsg:   rng.pick(ERROR_MSGS),
    dbHost:     rng.pick(DB_HOSTS),
    traceId:    rng.nextInt(0xFFFFFFFF).toString(16).padStart(8, '0'),
    service,
  };

  const message = template(vars);

  // Timestamp: spread 100k rows over 30 days (2,592,000 seconds)
  // Use id-based offset plus small random jitter for realism
  const spanSeconds = 30 * 24 * 3600; // 2,592,000
  const baseOffset = Math.floor((id / TOTAL_ROWS) * spanSeconds);
  const jitter = rng.nextRange(0, Math.floor(spanSeconds / TOTAL_ROWS) * 2);
  const tsMs = baseTs + (baseOffset + jitter) * 1000;
  const ts = new Date(tsMs).toISOString().replace('T', ' ').replace('Z', '');

  return { id, ts, severity, service, message };
}

export async function seedDatabase(db) {
  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*)::int AS cnt FROM logs');
  const existingCount = countResult.rows[0].cnt;

  if (existingCount >= TOTAL_ROWS) {
    console.log(`Database already seeded with ${existingCount} rows, skipping seed.`);
    return;
  }

  if (existingCount > 0) {
    console.log(`Partial seed detected (${existingCount} rows), clearing and reseeding...`);
    await db.exec('TRUNCATE logs');
  }

  console.log(`Seeding ${TOTAL_ROWS} log entries in batches of ${BATCH_SIZE}...`);
  const startTime = Date.now();

  // Base timestamp: 30 days ago from a fixed reference point for determinism
  // Use a fixed epoch: 2024-01-01T00:00:00Z
  const baseTs = new Date('2024-01-01T00:00:00Z').getTime();

  const rng = new LCG(42);

  let inserted = 0;
  while (inserted < TOTAL_ROWS) {
    const batchEnd = Math.min(inserted + BATCH_SIZE, TOTAL_ROWS);
    const rows = [];

    for (let i = inserted; i < batchEnd; i++) {
      rows.push(generateRow(rng, i + 1, baseTs));
    }

    // Build bulk insert
    await insertBatch(db, rows);
    inserted = batchEnd;

    if (inserted % 10000 === 0 || inserted === TOTAL_ROWS) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  Seeded ${inserted}/${TOTAL_ROWS} rows (${elapsed}s elapsed)`);
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Seeding complete: ${TOTAL_ROWS} rows in ${totalTime}s`);
}

async function insertBatch(db, rows) {
  if (rows.length === 0) return;

  // Build a multi-row INSERT with parameterized values
  const valuePlaceholders = [];
  const params = [];
  let paramIdx = 1;

  for (const row of rows) {
    valuePlaceholders.push(`($${paramIdx++}, $${paramIdx++}::timestamp, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
    params.push(row.id, row.ts, row.severity, row.service, row.message);
  }

  const sql = `
    INSERT INTO logs (id, ts, severity, service, message)
    VALUES ${valuePlaceholders.join(',\n')}
    ON CONFLICT (id) DO NOTHING
  `;

  await db.query(sql, params);
}
