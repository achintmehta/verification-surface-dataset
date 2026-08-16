/**
 * Deterministic seed of exactly 100,000 log entries.
 *
 * Determinism: all randomness is driven by a simple LCG seeded at a fixed value,
 * so the corpus is identical across restarts (until the table is dropped).
 *
 * Distribution:
 *   severity: ~60% debug, ~25% info, ~10% warn, ~5% error
 *   services: 8 services, roughly uniform
 *   timestamps: span 30 days ending at a fixed epoch
 *   messages: drawn from templates with variable fragments so substring search
 *             has both selective (rare) and non-selective (common) terms
 */

const TOTAL_ROWS = 100_000;
const BATCH_SIZE = 2_000;

const SERVICES = [
  'auth-service',
  'api-gateway',
  'user-service',
  'payment-service',
  'notification-service',
  'search-service',
  'analytics-service',
  'storage-service',
];

const SEVERITIES = ['debug', 'debug', 'debug', 'debug', 'debug', 'debug',
                    'info',  'info',  'info',
                    'warn',
                    'error'];
// 6/11 ≈ 54.5% debug, 3/11 ≈ 27.3% info, 1/11 ≈ 9.1% warn, 1/11 ≈ 9.1% error
// Adjust to hit ~60/25/10/5:
const SEVERITY_WEIGHTS = [
  { sev: 'debug', weight: 60 },
  { sev: 'info',  weight: 25 },
  { sev: 'warn',  weight: 10 },
  { sev: 'error', weight:  5 },
];
const SEVERITY_TOTAL = 100;

// Message templates with variable slots
// Some fragments are rare (selective), some are common (non-selective)
const COMMON_WORDS = [
  'request', 'response', 'connection', 'timeout', 'retry', 'cache',
  'database', 'query', 'index', 'record', 'session', 'token',
  'payload', 'header', 'status', 'metric', 'event', 'handler',
];

const RARE_WORDS = [
  'xylophone', 'quasar', 'zeppelin', 'fjord', 'vortex',
  'nebula', 'cryptex', 'labyrinth', 'phantasm', 'solstice',
];

const USER_IDS = Array.from({ length: 200 }, (_, i) => `user-${String(i + 1).padStart(5, '0')}`);
const REQUEST_IDS = Array.from({ length: 500 }, (_, i) => `req-${String(i + 1).padStart(6, '0')}`);
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
const HTTP_PATHS = [
  '/api/users', '/api/orders', '/api/products', '/api/auth/login',
  '/api/auth/logout', '/api/search', '/api/payments', '/api/notifications',
  '/health', '/metrics',
];
const HTTP_CODES = [200, 201, 204, 400, 401, 403, 404, 429, 500, 502, 503];

const MESSAGE_TEMPLATES = [
  (r) => `Received ${r.method} ${r.path} from ${r.userId} [${r.reqId}]`,
  (r) => `Completed ${r.method} ${r.path} with status ${r.code} in ${r.ms}ms [${r.reqId}]`,
  (r) => `Cache ${r.cacheOp} for key ${r.cacheKey} [${r.reqId}]`,
  (r) => `Database ${r.dbOp} on table ${r.table} took ${r.ms}ms`,
  (r) => `Session ${r.sessionOp} for ${r.userId}`,
  (r) => `Token ${r.tokenOp} for ${r.userId} [${r.reqId}]`,
  (r) => `Connection pool: ${r.poolSize} active, ${r.poolWait} waiting`,
  (r) => `Retry attempt ${r.retryNum} for ${r.method} ${r.path} [${r.reqId}]`,
  (r) => `Timeout after ${r.ms}ms on ${r.method} ${r.path} [${r.reqId}]`,
  (r) => `${r.common} processed successfully for ${r.userId}`,
  (r) => `Failed to process ${r.common} for ${r.userId}: ${r.errorMsg}`,
  (r) => `${r.rare} event detected in ${r.service} at offset ${r.offset}`,
  (r) => `Metric recorded: ${r.metricName}=${r.metricVal} for ${r.service}`,
  (r) => `Health check ${r.healthStatus} for ${r.service} (latency: ${r.ms}ms)`,
  (r) => `Queue depth ${r.queueDepth} for ${r.service} worker`,
  (r) => `Config reload triggered for ${r.service} [${r.reqId}]`,
  (r) => `Rate limit ${r.rateLimitOp} for ${r.userId} on ${r.path}`,
  (r) => `Audit: ${r.userId} performed ${r.auditAction} on ${r.table}`,
  (r) => `Batch job ${r.jobId} ${r.jobStatus}: processed ${r.batchCount} records`,
  (r) => `Circuit breaker ${r.cbState} for downstream ${r.service}`,
];

const CACHE_OPS = ['hit', 'miss', 'evict', 'set', 'invalidate'];
const DB_OPS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'UPSERT'];
const TABLES = ['users', 'orders', 'products', 'sessions', 'events', 'metrics', 'audit_log'];
const SESSION_OPS = ['created', 'refreshed', 'expired', 'invalidated'];
const TOKEN_OPS = ['issued', 'validated', 'revoked', 'refreshed'];
const HEALTH_STATUSES = ['OK', 'DEGRADED', 'FAILING'];
const RATE_LIMIT_OPS = ['warned', 'throttled', 'blocked'];
const AUDIT_ACTIONS = ['read', 'write', 'delete', 'export', 'import'];
const JOB_STATUSES = ['started', 'completed', 'failed', 'retrying'];
const CB_STATES = ['opened', 'closed', 'half-open'];
const ERROR_MSGS = [
  'connection refused', 'timeout exceeded', 'invalid payload',
  'permission denied', 'resource not found', 'rate limit exceeded',
  'internal error', 'dependency unavailable',
];

// Simple LCG for deterministic pseudo-random numbers
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
}

function pickSeverity(rng) {
  const roll = rng.nextInt(SEVERITY_TOTAL);
  let acc = 0;
  for (const { sev, weight } of SEVERITY_WEIGHTS) {
    acc += weight;
    if (roll < acc) return sev;
  }
  return 'debug';
}

function generateRow(rng, i, baseTs) {
  const severity = pickSeverity(rng);
  const service = rng.pick(SERVICES);

  // Spread timestamps over 30 days (in ms), deterministically
  // Use i as primary ordering factor with small jitter
  const spanMs = 30 * 24 * 60 * 60 * 1000;
  const jitterMs = Math.floor(rng.next() * 30000); // up to 30s jitter
  const tsMs = baseTs - spanMs + Math.floor((i / TOTAL_ROWS) * spanMs) + jitterMs;
  const ts = new Date(tsMs).toISOString();

  const templateFn = MESSAGE_TEMPLATES[rng.nextInt(MESSAGE_TEMPLATES.length)];
  const vars = {
    method: rng.pick(HTTP_METHODS),
    path: rng.pick(HTTP_PATHS),
    userId: rng.pick(USER_IDS),
    reqId: rng.pick(REQUEST_IDS),
    code: rng.pick(HTTP_CODES),
    ms: rng.nextInt(5000) + 1,
    cacheOp: rng.pick(CACHE_OPS),
    cacheKey: `${rng.pick(TABLES)}:${rng.nextInt(10000)}`,
    dbOp: rng.pick(DB_OPS),
    table: rng.pick(TABLES),
    sessionOp: rng.pick(SESSION_OPS),
    tokenOp: rng.pick(TOKEN_OPS),
    poolSize: rng.nextInt(50) + 1,
    poolWait: rng.nextInt(20),
    retryNum: rng.nextInt(5) + 1,
    common: rng.pick(COMMON_WORDS),
    rare: rng.pick(RARE_WORDS),
    offset: rng.nextInt(100000),
    metricName: `${rng.pick(COMMON_WORDS)}_${rng.pick(['count', 'rate', 'latency', 'size'])}`,
    metricVal: (rng.next() * 1000).toFixed(2),
    healthStatus: rng.pick(HEALTH_STATUSES),
    queueDepth: rng.nextInt(1000),
    jobId: `job-${rng.nextInt(9999) + 1}`,
    jobStatus: rng.pick(JOB_STATUSES),
    batchCount: rng.nextInt(10000) + 1,
    cbState: rng.pick(CB_STATES),
    rateLimitOp: rng.pick(RATE_LIMIT_OPS),
    auditAction: rng.pick(AUDIT_ACTIONS),
    errorMsg: rng.pick(ERROR_MSGS),
    service,
  };

  const message = templateFn(vars);
  return { ts, severity, service, message };
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
    console.log(`Found ${existing} rows (incomplete seed). Truncating and reseeding...`);
    await db.exec('TRUNCATE TABLE logs RESTART IDENTITY');
  }

  console.log(`Seeding ${TOTAL_ROWS} log entries...`);
  const startTime = Date.now();

  const rng = new LCG(0xdeadbeef);
  // Fixed base timestamp: 2024-01-31T00:00:00Z
  const baseTs = new Date('2024-01-31T00:00:00Z').getTime();

  let inserted = 0;

  while (inserted < TOTAL_ROWS) {
    const batchCount = Math.min(BATCH_SIZE, TOTAL_ROWS - inserted);
    const rows = [];

    for (let i = 0; i < batchCount; i++) {
      rows.push(generateRow(rng, inserted + i, baseTs));
    }

    // Build a single multi-row INSERT for the batch
    const valuePlaceholders = [];
    const values = [];
    let pIdx = 1;

    for (const row of rows) {
      valuePlaceholders.push(`($${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++})`);
      values.push(row.ts, row.severity, row.service, row.message);
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${valuePlaceholders.join(', ')}`;
    await db.query(sql, values);

    inserted += batchCount;

    if (inserted % 10000 === 0 || inserted === TOTAL_ROWS) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  Seeded ${inserted}/${TOTAL_ROWS} rows (${elapsed}s elapsed)`);
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Seeding complete: ${TOTAL_ROWS} rows in ${totalTime}s`);
}
