/**
 * Deterministic seed generator for 100,000 log entries.
 * Uses a simple LCG (linear congruential generator) for reproducibility.
 */

const TOTAL_ROWS = 100_000;
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

// Severity distribution: ~60% info, ~25% debug, ~10% warn, ~5% error
const SEVERITY_WEIGHTS = [
  { severity: 'debug', weight: 25 },
  { severity: 'info',  weight: 60 },
  { severity: 'warn',  weight: 10 },
  { severity: 'error', weight: 5  },
];

const SEVERITY_CUMULATIVE = [];
let cumSum = 0;
for (const { severity, weight } of SEVERITY_WEIGHTS) {
  cumSum += weight;
  SEVERITY_CUMULATIVE.push({ severity, cum: cumSum });
}
const SEVERITY_TOTAL = cumSum; // 100

// Message templates with variable fragments
// Some terms are selective (rare), some are non-selective (common)
const MESSAGE_TEMPLATES = [
  // info templates
  (r) => `User ${r.userId} logged in from IP ${r.ip}`,
  (r) => `Request processed in ${r.ms}ms for endpoint ${r.endpoint}`,
  (r) => `Cache hit for key ${r.cacheKey}`,
  (r) => `Cache miss for key ${r.cacheKey}`,
  (r) => `Session ${r.sessionId} created for user ${r.userId}`,
  (r) => `Health check passed for service ${r.service}`,
  (r) => `Configuration reloaded successfully`,
  (r) => `Batch job ${r.jobId} completed with ${r.count} records processed`,
  (r) => `Database connection pool size: ${r.poolSize}`,
  (r) => `Scheduled task ${r.taskName} executed`,
  // debug templates
  (r) => `Entering function ${r.funcName} with args ${r.args}`,
  (r) => `SQL query executed: SELECT * FROM ${r.table} WHERE id=${r.id}`,
  (r) => `Response payload size: ${r.bytes} bytes`,
  (r) => `Token validation successful for user ${r.userId}`,
  (r) => `Retry attempt ${r.attempt} for operation ${r.opName}`,
  (r) => `Queue depth: ${r.queueDepth} messages pending`,
  (r) => `Memory usage: ${r.memMb}MB heap used`,
  (r) => `Trace ID ${r.traceId} span ${r.spanId} recorded`,
  // warn templates
  (r) => `Slow query detected: ${r.ms}ms for ${r.endpoint}`,
  (r) => `Rate limit approaching for user ${r.userId}: ${r.count} requests`,
  (r) => `Deprecated API endpoint ${r.endpoint} called by ${r.ip}`,
  (r) => `High memory usage detected: ${r.memMb}MB`,
  (r) => `Connection pool exhausted, waiting for available connection`,
  (r) => `Retry limit reached for job ${r.jobId}`,
  // error templates
  (r) => `Authentication failed for user ${r.userId} from IP ${r.ip}`,
  (r) => `Database connection error: timeout after ${r.ms}ms`,
  (r) => `Unhandled exception in ${r.funcName}: ${r.errorMsg}`,
  (r) => `Payment processing failed for transaction ${r.txId}: ${r.errorMsg}`,
  (r) => `Service ${r.service} unreachable after ${r.attempt} retries`,
  (r) => `Critical: disk usage at ${r.pct}% on ${r.host}`,
];

const ENDPOINTS = [
  '/api/users', '/api/orders', '/api/products', '/api/auth/login',
  '/api/auth/logout', '/api/payments', '/api/search', '/api/inventory',
  '/api/notifications', '/api/reports', '/api/admin/users', '/api/health',
];

const FUNC_NAMES = [
  'processRequest', 'validateToken', 'fetchUserData', 'updateInventory',
  'sendNotification', 'calculateTotal', 'applyDiscount', 'generateReport',
  'syncDatabase', 'cleanupSessions',
];

const TASK_NAMES = [
  'cleanup-expired-sessions', 'send-digest-emails', 'reindex-search',
  'archive-old-logs', 'sync-inventory', 'generate-daily-report',
];

const ERROR_MSGS = [
  'connection refused', 'timeout exceeded', 'null pointer exception',
  'invalid argument', 'permission denied', 'resource not found',
  'deadlock detected', 'out of memory',
];

const TABLES = ['users', 'orders', 'products', 'sessions', 'payments', 'inventory'];

// Simple LCG for deterministic pseudo-random numbers
class LCG {
  constructor(seed) {
    this.state = seed >>> 0;
  }
  next() {
    // Parameters from Numerical Recipes
    this.state = (Math.imul(1664525, this.state) + 1013904223) >>> 0;
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
  const roll = rng.nextInt(SEVERITY_TOTAL);
  for (const { severity, cum } of SEVERITY_CUMULATIVE) {
    if (roll < cum) return severity;
  }
  return 'info';
}

function generateRow(i, rng) {
  // Timestamps span 30 days, distributed across the range
  // Base: 30 days ago from a fixed reference point (2024-01-31T00:00:00Z)
  const BASE_TS = 1706659200000; // 2024-01-31 00:00:00 UTC
  const SPAN_MS = 30 * 24 * 60 * 60 * 1000;
  // Use index-based offset plus some jitter for determinism
  const fraction = i / TOTAL_ROWS;
  const jitter = rng.next() * (SPAN_MS / TOTAL_ROWS) * 2;
  const tsMs = BASE_TS + Math.floor(fraction * SPAN_MS + jitter);
  const ts = new Date(tsMs).toISOString();

  const severity = pickSeverity(rng);
  const service = SERVICES[rng.nextInt(SERVICES.length)];

  // Build template variables
  const vars = {
    userId: `u${rng.nextIntRange(1000, 9999)}`,
    ip: `${rng.nextIntRange(1,255)}.${rng.nextIntRange(0,255)}.${rng.nextIntRange(0,255)}.${rng.nextIntRange(1,255)}`,
    ms: rng.nextIntRange(1, 5000),
    endpoint: ENDPOINTS[rng.nextInt(ENDPOINTS.length)],
    cacheKey: `cache:${rng.nextInt(10000)}`,
    sessionId: `sess_${rng.nextInt(1000000).toString(16)}`,
    jobId: `job_${rng.nextInt(100000)}`,
    count: rng.nextIntRange(1, 10000),
    poolSize: rng.nextIntRange(5, 50),
    taskName: TASK_NAMES[rng.nextInt(TASK_NAMES.length)],
    funcName: FUNC_NAMES[rng.nextInt(FUNC_NAMES.length)],
    args: `[${rng.nextInt(1000)}, "${rng.nextInt(100)}"]`,
    table: TABLES[rng.nextInt(TABLES.length)],
    id: rng.nextInt(100000),
    bytes: rng.nextIntRange(100, 100000),
    attempt: rng.nextIntRange(1, 5),
    opName: `op_${rng.nextInt(1000)}`,
    queueDepth: rng.nextIntRange(0, 10000),
    memMb: rng.nextIntRange(100, 8000),
    traceId: rng.nextInt(0xFFFFFF).toString(16).padStart(6, '0'),
    spanId: rng.nextInt(0xFFFF).toString(16).padStart(4, '0'),
    pct: rng.nextIntRange(80, 100),
    host: `host-${rng.nextInt(20)}`,
    txId: `tx_${rng.nextInt(1000000)}`,
    errorMsg: ERROR_MSGS[rng.nextInt(ERROR_MSGS.length)],
    service,
  };

  const templateIdx = rng.nextInt(MESSAGE_TEMPLATES.length);
  const message = MESSAGE_TEMPLATES[templateIdx](vars);

  return { ts, severity, service, message };
}

export function generateSeedRows() {
  const rng = new LCG(42); // fixed seed for determinism
  const rows = [];
  for (let i = 0; i < TOTAL_ROWS; i++) {
    rows.push(generateRow(i, rng));
  }
  return rows;
}

export { TOTAL_ROWS };
