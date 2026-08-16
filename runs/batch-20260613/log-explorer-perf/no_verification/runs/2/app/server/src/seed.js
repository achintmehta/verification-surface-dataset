/**
 * Deterministic seed of exactly 100,000 log entries.
 *
 * Determinism: every value is derived from the row index via a simple LCG-style
 * hash so the corpus is identical across restarts.
 *
 * Distribution:
 *   severity: ~60% debug, ~25% info, ~10% warn, ~5% error
 *   services: 8 services, round-robin with hash offset
 *   timestamps: evenly spread over 30 days ending at a fixed epoch
 *   messages: drawn from templates with variable fragments so substring
 *              search has both selective (rare) and non-selective (common) terms
 */

const TOTAL_ROWS = 100_000;
const BATCH_SIZE = 2_000;

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

const SEVERITIES = ['debug', 'debug', 'debug', 'debug', 'debug', 'debug',
                    'info',  'info',  'info',
                    'warn',
                    'error'];
// Approx 6/11 debug (~54%), 3/11 info (~27%), 1/11 warn (~9%), 1/11 error (~9%)
// Adjusted below with weighted selection for exact ~60/25/10/5

// Fixed epoch: 2024-01-31T00:00:00Z in ms
const END_EPOCH_MS = 1706659200000;
const SPAN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const START_EPOCH_MS = END_EPOCH_MS - SPAN_MS;

// Message templates — mix of selective and non-selective terms
const MESSAGE_TEMPLATES = [
  // debug templates
  (v) => `Cache lookup for key="${v.key}" returned ${v.hit ? 'HIT' : 'MISS'} in ${v.dur}ms`,
  (v) => `DB query executed: table=${v.table} rows_scanned=${v.rows} duration=${v.dur}ms`,
  (v) => `HTTP request received: method=${v.method} path=${v.path} user_agent="${v.ua}"`,
  (v) => `Session token validated for user_id=${v.uid} session=${v.session}`,
  (v) => `Config reload triggered; key=${v.key} old_value="${v.old}" new_value="${v.new}"`,
  (v) => `Heartbeat ping from worker=${v.worker} pid=${v.pid} memory_mb=${v.mem}`,
  (v) => `Queue depth check: queue=${v.queue} depth=${v.depth} consumers=${v.consumers}`,
  (v) => `Feature flag evaluated: flag=${v.flag} result=${v.result} user=${v.uid}`,
  // info templates
  (v) => `User ${v.uid} logged in from IP ${v.ip} using ${v.method}`,
  (v) => `Order ${v.orderId} created for user ${v.uid} total=$${v.amount}`,
  (v) => `Payment processed: order=${v.orderId} gateway=${v.gateway} status=success`,
  (v) => `Email notification sent to user=${v.uid} template=${v.template}`,
  (v) => `Service started successfully on port ${v.port} version=${v.version}`,
  (v) => `Scheduled job "${v.job}" completed in ${v.dur}ms processed=${v.rows} records`,
  (v) => `API rate limit check: user=${v.uid} requests=${v.reqs} limit=${v.limit} window=60s`,
  // warn templates
  (v) => `Slow query detected: table=${v.table} duration=${v.dur}ms threshold=500ms`,
  (v) => `Retry attempt ${v.attempt} of ${v.max} for operation="${v.op}" error="${v.err}"`,
  (v) => `Memory usage high: service=${v.service} used_mb=${v.mem} threshold_mb=${v.threshold}`,
  (v) => `Deprecated API endpoint called: path=${v.path} caller=${v.uid} sunset_date=${v.date}`,
  (v) => `Connection pool exhausted: pool=${v.pool} size=${v.size} waiting=${v.waiting}`,
  // error templates
  (v) => `Unhandled exception in ${v.service}: ${v.err} stack_trace_id=${v.traceId}`,
  (v) => `Database connection failed: host=${v.host} port=${v.port} error="${v.err}"`,
  (v) => `Payment gateway timeout: order=${v.orderId} gateway=${v.gateway} timeout_ms=${v.dur}`,
  (v) => `Authentication failure: user=${v.uid} reason="${v.reason}" ip=${v.ip}`,
];

// Severity weights: debug=60, info=25, warn=10, error=5 (out of 100)
const SEVERITY_THRESHOLDS = [60, 85, 95, 100]; // cumulative
const SEVERITY_NAMES = ['debug', 'info', 'warn', 'error'];

// Template index ranges by severity
const TEMPLATE_RANGES = {
  debug: [0, 7],
  info:  [8, 14],
  warn:  [15, 19],
  error: [20, 23],
};

// Variable pools for template substitution
const KEYS = ['user:session', 'product:cache', 'rate:limit', 'config:db', 'feature:dark-mode',
               'auth:token', 'search:index', 'payment:pending', 'order:draft', 'analytics:batch'];
const TABLES = ['users', 'orders', 'payments', 'sessions', 'products', 'inventory', 'events', 'notifications'];
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
const PATHS = ['/api/users', '/api/orders', '/api/payments', '/api/search', '/api/products',
               '/health', '/api/auth/login', '/api/auth/logout', '/api/notifications', '/api/analytics'];
const UAS = ['Mozilla/5.0 Chrome/120', 'Mozilla/5.0 Firefox/121', 'curl/7.88', 'axios/1.6', 'Go-http-client/2.0'];
const GATEWAYS = ['stripe', 'paypal', 'braintree', 'adyen'];
const TEMPLATES_LIST = ['welcome', 'order-confirm', 'password-reset', 'invoice', 'promo'];
const JOBS = ['cleanup-sessions', 'aggregate-metrics', 'send-digests', 'reindex-search', 'archive-logs'];
const ERRORS = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'SSL_ERROR', 'PROTOCOL_ERROR'];
const REASONS = ['invalid_password', 'account_locked', 'token_expired', 'ip_blocked', 'mfa_required'];
const POOLS = ['read-replica', 'write-primary', 'analytics-db', 'cache-db'];
const OPS = ['send-email', 'charge-card', 'update-inventory', 'sync-search', 'export-report'];

// Simple deterministic hash (xorshift32-like)
function hash32(n) {
  let x = n ^ 0xdeadbeef;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = x ^ (x >>> 16);
  return x >>> 0; // unsigned 32-bit
}

function pick(arr, seed) {
  return arr[seed % arr.length];
}

function buildVars(i) {
  const h1 = hash32(i);
  const h2 = hash32(i + 100003);
  const h3 = hash32(i + 200007);
  const h4 = hash32(i + 300011);
  return {
    key:       pick(KEYS, h1),
    hit:       (h1 & 1) === 0,
    dur:       (h2 % 2000) + 1,
    table:     pick(TABLES, h2),
    rows:      (h3 % 10000) + 1,
    method:    pick(METHODS, h3),
    path:      pick(PATHS, h4),
    ua:        pick(UAS, h1 >> 3),
    uid:       `u${(h2 % 9999) + 1}`,
    session:   `sess_${(h3 % 99999).toString(16)}`,
    old:       `v${h1 % 10}`,
    new:       `v${(h1 % 10) + 1}`,
    worker:    `worker-${h2 % 8}`,
    pid:       10000 + (h3 % 55535),
    mem:       (h4 % 4096) + 64,
    queue:     `q-${pick(['high', 'normal', 'low', 'dead-letter'], h1)}`,
    depth:     h2 % 10000,
    consumers: (h3 % 16) + 1,
    flag:      pick(['dark-mode', 'new-checkout', 'beta-search', 'v2-api', 'ml-recs'], h4),
    result:    (h1 & 3) !== 0 ? 'true' : 'false',
    ip:        `${(h1 % 223) + 1}.${(h2 % 254) + 1}.${(h3 % 254) + 1}.${(h4 % 254) + 1}`,
    orderId:   `ord_${(h2 % 999999).toString(36)}`,
    amount:    ((h3 % 99900) + 100) / 100,
    gateway:   pick(GATEWAYS, h4),
    template:  pick(TEMPLATES_LIST, h1),
    port:      3000 + (h2 % 1000),
    version:   `${(h3 % 5) + 1}.${h4 % 20}.${h1 % 100}`,
    job:       pick(JOBS, h2),
    reqs:      h3 % 1000,
    limit:     100 + (h4 % 900),
    threshold: (h1 % 3000) + 1000,
    attempt:   (h2 % 5) + 1,
    max:       5,
    op:        pick(OPS, h3),
    err:       pick(ERRORS, h4),
    service:   pick(SERVICES, h1),
    traceId:   `tr_${h2.toString(16)}${h3.toString(16)}`,
    host:      `db-${h4 % 4}.internal`,
    reason:    pick(REASONS, h1),
    pool:      pick(POOLS, h2),
    waiting:   h3 % 50,
    size:      (h4 % 20) + 5,
    date:      `2024-${String((h1 % 12) + 1).padStart(2, '0')}-${String((h2 % 28) + 1).padStart(2, '0')}`,
  };
}

function buildRow(i) {
  // Deterministic timestamp: evenly spread + small jitter
  const baseMs = START_EPOCH_MS + Math.floor((i / TOTAL_ROWS) * SPAN_MS);
  const jitterMs = hash32(i + 400013) % 60000; // up to 1 minute jitter
  const ts = new Date(baseMs + jitterMs).toISOString();

  // Severity by weighted threshold
  const sevRand = hash32(i + 500017) % 100;
  let severityIdx = 0;
  for (let s = 0; s < SEVERITY_THRESHOLDS.length; s++) {
    if (sevRand < SEVERITY_THRESHOLDS[s]) { severityIdx = s; break; }
  }
  const severity = SEVERITY_NAMES[severityIdx];

  // Service
  const service = pick(SERVICES, hash32(i + 600019));

  // Template within severity range
  const [tMin, tMax] = TEMPLATE_RANGES[severity];
  const tRange = tMax - tMin + 1;
  const tIdx = tMin + (hash32(i + 700023) % tRange);
  const vars = buildVars(i);
  const message = MESSAGE_TEMPLATES[tIdx](vars);

  return { id: i + 1, ts, severity, service, message };
}

export async function seedLogs(db) {
  let inserted = 0;

  for (let batchStart = 0; batchStart < TOTAL_ROWS; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL_ROWS);
    const rows = [];

    for (let i = batchStart; i < batchEnd; i++) {
      rows.push(buildRow(i));
    }

    // Build a multi-row INSERT for the batch
    const valuePlaceholders = [];
    const params = [];
    let paramIdx = 1;

    for (const row of rows) {
      valuePlaceholders.push(`($${paramIdx}, $${paramIdx+1}, $${paramIdx+2}, $${paramIdx+3}, $${paramIdx+4})`);
      params.push(row.id, row.ts, row.severity, row.service, row.message);
      paramIdx += 5;
    }

    const sql = `INSERT INTO logs (id, ts, severity, service, message) VALUES ${valuePlaceholders.join(',')}`;
    await db.query(sql, params);

    inserted += rows.length;
    if (inserted % 10000 === 0) {
      console.log(`[seed] Inserted ${inserted}/${TOTAL_ROWS} rows...`);
    }
  }

  console.log(`[seed] Done: ${inserted} rows inserted`);
}
