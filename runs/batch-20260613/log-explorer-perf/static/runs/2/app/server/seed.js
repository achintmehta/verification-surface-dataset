/**
 * Deterministic seed: 100,000 log rows spanning 30 days across 8 services.
 * Severity distribution: ~60% debug, ~25% info, ~10% warn, ~5% error.
 * Messages drawn from templates with variable fragments so substring search
 * has both selective (rare) and non-selective (common) terms.
 */

const SERVICES = [
  'api-gateway',
  'auth-service',
  'billing-service',
  'cache-service',
  'data-pipeline',
  'notification-service',
  'search-service',
  'user-service',
];

const SEVERITY_WEIGHTS = [
  { sev: 'debug', weight: 60 },
  { sev: 'info',  weight: 25 },
  { sev: 'warn',  weight: 10 },
  { sev: 'error', weight: 5  },
];
const SEVERITY_TOTAL = 100;

// Message templates — {VAR} placeholders are filled deterministically
const MESSAGE_TEMPLATES = [
  // debug
  'Processing request {REQ_ID} for user {USER_ID} on endpoint {ENDPOINT}',
  'Cache lookup for key {CACHE_KEY}: {CACHE_RESULT}',
  'DB query executed in {DURATION}ms: SELECT * FROM {TABLE} WHERE id={ROW_ID}',
  'Heartbeat tick #{TICK} — all systems nominal',
  'Loaded config {CONFIG_KEY}={CONFIG_VAL} from environment',
  'Retry attempt {ATTEMPT} of {MAX_ATTEMPTS} for job {JOB_ID}',
  'Span {SPAN_ID} started for trace {TRACE_ID}',
  'Span {SPAN_ID} finished in {DURATION}ms',
  'Queue depth for {QUEUE_NAME}: {QUEUE_DEPTH} messages',
  'Scheduled task {TASK_NAME} triggered at {CRON_TIME}',
  // info
  'User {USER_ID} authenticated successfully via {AUTH_METHOD}',
  'Order {ORDER_ID} created for customer {CUSTOMER_ID} — total {AMOUNT}',
  'Deployment {DEPLOY_ID} completed successfully on {ENV}',
  'Service {SERVICE_NAME} started on port {PORT}',
  'Webhook {WEBHOOK_ID} delivered to {WEBHOOK_URL} — status {STATUS_CODE}',
  'Email notification sent to {EMAIL} for event {EVENT_TYPE}',
  'Search query "{SEARCH_TERM}" returned {RESULT_COUNT} results in {DURATION}ms',
  'Payment {PAYMENT_ID} processed — amount {AMOUNT} via {PAYMENT_METHOD}',
  'Session {SESSION_ID} created for user {USER_ID}',
  'File {FILENAME} uploaded by user {USER_ID} — size {FILE_SIZE}',
  // warn
  'Rate limit approaching for client {CLIENT_ID}: {CURRENT_RATE}/{MAX_RATE} req/s',
  'Slow query detected ({DURATION}ms): SELECT * FROM {TABLE} WHERE {CONDITION}',
  'Memory usage at {MEM_PCT}% — threshold is {MEM_THRESHOLD}%',
  'Deprecated API endpoint {ENDPOINT} called by {CLIENT_ID}',
  'Retry {ATTEMPT}/{MAX_ATTEMPTS} for external service {SERVICE_NAME}',
  'Certificate for {DOMAIN} expires in {DAYS} days',
  'Disk usage on {VOLUME} at {DISK_PCT}%',
  // error
  'Failed to connect to database {DB_HOST}:{DB_PORT} after {ATTEMPTS} attempts',
  'Unhandled exception in {SERVICE_NAME}: {ERROR_MSG}',
  'Payment {PAYMENT_ID} failed — {ERROR_MSG}',
  'Authentication failed for user {USER_ID} from IP {IP_ADDR}',
  'Job {JOB_ID} exceeded timeout of {TIMEOUT}s',
  'Circuit breaker OPEN for {SERVICE_NAME} — {FAILURE_COUNT} failures',
];

// Variable pools — deterministic, varied enough for selective/non-selective search
const ENDPOINTS = ['/api/users', '/api/orders', '/api/products', '/api/search', '/api/auth',
                   '/api/billing', '/api/notifications', '/api/reports', '/api/health', '/api/metrics'];
const AUTH_METHODS = ['password', 'oauth2', 'saml', 'api-key', 'mfa'];
const PAYMENT_METHODS = ['credit-card', 'paypal', 'bank-transfer', 'crypto', 'invoice'];
const ENVS = ['production', 'staging', 'canary', 'dev'];
const STATUS_CODES = ['200', '201', '204', '400', '401', '403', '404', '500', '502', '503'];
const TABLES = ['users', 'orders', 'products', 'sessions', 'events', 'audit_log', 'payments'];
const QUEUES = ['email-queue', 'sms-queue', 'webhook-queue', 'export-queue', 'import-queue'];
const TASKS = ['cleanup-sessions', 'send-digests', 'reindex-search', 'archive-logs', 'sync-billing'];
const DOMAINS = ['api.example.com', 'auth.example.com', 'cdn.example.com', 'mail.example.com'];
const VOLUMES = ['/data', '/var/log', '/tmp', '/backup'];
const CACHE_RESULTS = ['HIT', 'MISS', 'STALE', 'EXPIRED'];
const EVENT_TYPES = ['signup', 'purchase', 'refund', 'password-reset', 'account-locked', 'export-ready'];
const ERROR_MSGS = [
  'connection refused',
  'timeout exceeded',
  'null pointer dereference',
  'disk quota exceeded',
  'invalid token',
  'rate limit exceeded',
  'service unavailable',
  'unexpected EOF',
];

// Simple deterministic LCG pseudo-random number generator
function makeLCG(seed) {
  let s = seed >>> 0;
  return function () {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function pick(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

function pickSeverity(rng) {
  const r = Math.floor(rng() * SEVERITY_TOTAL);
  let acc = 0;
  for (const { sev, weight } of SEVERITY_WEIGHTS) {
    acc += weight;
    if (r < acc) return sev;
  }
  return 'debug';
}

function padTwo(n) {
  return String(n).padStart(2, '0');
}

function buildMessage(template, rng) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    switch (key) {
      case 'REQ_ID':       return `req-${Math.floor(rng() * 1e9).toString(16)}`;
      case 'USER_ID':      return `usr-${Math.floor(rng() * 100000)}`;
      case 'CUSTOMER_ID':  return `cust-${Math.floor(rng() * 50000)}`;
      case 'CLIENT_ID':    return `cli-${Math.floor(rng() * 10000)}`;
      case 'ORDER_ID':     return `ord-${Math.floor(rng() * 1000000)}`;
      case 'PAYMENT_ID':   return `pay-${Math.floor(rng() * 1000000)}`;
      case 'SESSION_ID':   return `sess-${Math.floor(rng() * 1e9).toString(16)}`;
      case 'DEPLOY_ID':    return `deploy-${Math.floor(rng() * 10000)}`;
      case 'WEBHOOK_ID':   return `wh-${Math.floor(rng() * 100000)}`;
      case 'JOB_ID':       return `job-${Math.floor(rng() * 100000)}`;
      case 'SPAN_ID':      return `span-${Math.floor(rng() * 1e9).toString(16)}`;
      case 'TRACE_ID':     return `trace-${Math.floor(rng() * 1e9).toString(16)}`;
      case 'CACHE_KEY':    return `cache:${pick(TABLES, rng)}:${Math.floor(rng() * 10000)}`;
      case 'CACHE_RESULT': return pick(CACHE_RESULTS, rng);
      case 'ENDPOINT':     return pick(ENDPOINTS, rng);
      case 'AUTH_METHOD':  return pick(AUTH_METHODS, rng);
      case 'PAYMENT_METHOD': return pick(PAYMENT_METHODS, rng);
      case 'ENV':          return pick(ENVS, rng);
      case 'STATUS_CODE':  return pick(STATUS_CODES, rng);
      case 'TABLE':        return pick(TABLES, rng);
      case 'QUEUE_NAME':   return pick(QUEUES, rng);
      case 'TASK_NAME':    return pick(TASKS, rng);
      case 'DOMAIN':       return pick(DOMAINS, rng);
      case 'VOLUME':       return pick(VOLUMES, rng);
      case 'EVENT_TYPE':   return pick(EVENT_TYPES, rng);
      case 'ERROR_MSG':    return pick(ERROR_MSGS, rng);
      case 'SERVICE_NAME': return pick(SERVICES, rng);
      case 'WEBHOOK_URL':  return `https://hooks.example.com/${Math.floor(rng() * 10000)}`;
      case 'EMAIL':        return `user${Math.floor(rng() * 100000)}@example.com`;
      case 'FILENAME':     return `upload-${Math.floor(rng() * 1000000)}.bin`;
      case 'SEARCH_TERM':  return pick(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa'], rng);
      case 'CONFIG_KEY':   return pick(['LOG_LEVEL', 'DB_POOL_SIZE', 'CACHE_TTL', 'MAX_RETRIES', 'TIMEOUT'], rng);
      case 'CONFIG_VAL':   return String(Math.floor(rng() * 100));
      case 'CONDITION':    return `status='${pick(['active','inactive','pending'], rng)}'`;
      case 'DURATION':     return String(Math.floor(rng() * 2000) + 1);
      case 'TICK':         return String(Math.floor(rng() * 1000000));
      case 'ATTEMPT':      return String(Math.floor(rng() * 5) + 1);
      case 'MAX_ATTEMPTS': return String(Math.floor(rng() * 3) + 3);
      case 'RESULT_COUNT': return String(Math.floor(rng() * 10000));
      case 'FILE_SIZE':    return `${Math.floor(rng() * 100)}MB`;
      case 'CURRENT_RATE': return String(Math.floor(rng() * 1000));
      case 'MAX_RATE':     return '1000';
      case 'MEM_PCT':      return String(Math.floor(rng() * 40) + 60);
      case 'MEM_THRESHOLD': return '90';
      case 'DISK_PCT':     return String(Math.floor(rng() * 30) + 70);
      case 'DAYS':         return String(Math.floor(rng() * 30) + 1);
      case 'DB_HOST':      return pick(['db-primary', 'db-replica-1', 'db-replica-2'], rng);
      case 'DB_PORT':      return '5432';
      case 'ATTEMPTS':     return String(Math.floor(rng() * 5) + 1);
      case 'TIMEOUT':      return String(Math.floor(rng() * 60) + 10);
      case 'FAILURE_COUNT': return String(Math.floor(rng() * 20) + 5);
      case 'IP_ADDR':      return `${Math.floor(rng()*256)}.${Math.floor(rng()*256)}.${Math.floor(rng()*256)}.${Math.floor(rng()*256)}`;
      case 'AMOUNT':       return `$${(rng() * 10000).toFixed(2)}`;
      case 'PORT':         return String(Math.floor(rng() * 10000) + 3000);
      case 'ROW_ID':       return String(Math.floor(rng() * 1000000));
      case 'QUEUE_DEPTH':  return String(Math.floor(rng() * 10000));
      case 'CRON_TIME':    return `${padTwo(Math.floor(rng()*24))}:${padTwo(Math.floor(rng()*60))}`;
      default:             return key;
    }
  });
}

const TOTAL_ROWS = 100_000;
const BATCH_SIZE = 1000;
// 30 days in ms
const SPAN_MS = 30 * 24 * 60 * 60 * 1000;
const END_TS = new Date('2024-01-31T23:59:59.000Z').getTime();
const START_TS = END_TS - SPAN_MS;

export async function seed(db) {
  const rng = makeLCG(0xdeadbeef);

  // Pre-generate all rows in memory, then batch-insert
  // We generate timestamps spread evenly + jitter across 30 days
  const rows = [];
  for (let i = 0; i < TOTAL_ROWS; i++) {
    // Deterministic timestamp: evenly spaced with small jitter
    const fraction = i / TOTAL_ROWS;
    const jitter = (rng() - 0.5) * (SPAN_MS / TOTAL_ROWS) * 2;
    const tsMs = Math.round(START_TS + fraction * SPAN_MS + jitter);
    const ts = new Date(Math.max(START_TS, Math.min(END_TS, tsMs))).toISOString();

    const severity = pickSeverity(rng);
    const service = pick(SERVICES, rng);
    const template = pick(MESSAGE_TEMPLATES, rng);
    const message = buildMessage(template, rng);

    rows.push({ ts, severity, service, message });
  }

  // Insert in batches
  const numBatches = Math.ceil(TOTAL_ROWS / BATCH_SIZE);
  for (let b = 0; b < numBatches; b++) {
    const batch = rows.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
    const values = batch
      .map((r) =>
        `('${r.ts}', '${r.severity}', '${escapeSql(r.service)}', '${escapeSql(r.message)}')`
      )
      .join(',\n');

    await db.exec(
      `INSERT INTO logs (ts, severity, service, message) VALUES ${values}`
    );

    if ((b + 1) % 20 === 0) {
      console.log(`[seed] Inserted ${(b + 1) * BATCH_SIZE} / ${TOTAL_ROWS} rows…`);
    }
  }
}

function escapeSql(str) {
  // Escape single quotes for SQL string literals.
  // Backslashes are not special in standard PostgreSQL string literals
  // (only in E'' escape strings, which we don't use).
  return str.replace(/'/g, "''");
}
