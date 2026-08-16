/**
 * Deterministic seed: 100,000 log entries spanning 30 days across 8 services.
 * Severity distribution: ~60% debug, ~25% info, ~10% warn, ~5% error.
 * Messages drawn from templates with variable fragments for selective/non-selective search.
 */

const SERVICES = [
  'api-gateway',
  'auth-service',
  'user-service',
  'payment-service',
  'notification-service',
  'analytics-service',
  'cache-service',
  'scheduler-service',
];

const SEVERITIES = ['debug', 'debug', 'debug', 'debug', 'debug', 'debug',
                    'info', 'info', 'info', 'info', 'info',
                    'warn', 'warn',
                    'error'];
// 6/14 debug ≈ 42.8%, 5/14 info ≈ 35.7%, 2/14 warn ≈ 14.3%, 1/14 error ≈ 7.1%
// Adjusted to hit ~60/25/10/5:
const SEVERITY_WEIGHTS = [
  { sev: 'debug', weight: 60 },
  { sev: 'info',  weight: 25 },
  { sev: 'warn',  weight: 10 },
  { sev: 'error', weight: 5  },
];

// Build a lookup array for O(1) weighted selection
const SEVERITY_TABLE = [];
for (const { sev, weight } of SEVERITY_WEIGHTS) {
  for (let i = 0; i < weight; i++) SEVERITY_TABLE.push(sev);
}
// SEVERITY_TABLE.length === 100

// Message templates — mix of selective (unique tokens) and non-selective (common words)
const MESSAGE_TEMPLATES = [
  // debug
  (r) => `Processing request ${r.reqId} for user ${r.userId} on route ${r.route}`,
  (r) => `Cache lookup for key ${r.cacheKey}: ${r.hit ? 'HIT' : 'MISS'} (ttl=${r.ttl}s)`,
  (r) => `DB query executed in ${r.duration}ms: SELECT * FROM ${r.table} WHERE id=${r.rowId}`,
  (r) => `Heartbeat check passed for node ${r.nodeId} at ${r.addr}`,
  (r) => `Scheduler tick ${r.tick}: next job ${r.jobName} in ${r.delay}ms`,
  (r) => `Token validation for session ${r.sessionId}: valid=${r.valid}`,
  (r) => `Retry attempt ${r.attempt} of ${r.maxAttempts} for task ${r.taskId}`,
  (r) => `Serializing response payload (${r.bytes} bytes) for request ${r.reqId}`,
  // info
  (r) => `User ${r.userId} logged in from ${r.addr} using ${r.authMethod}`,
  (r) => `Payment ${r.paymentId} processed successfully for amount ${r.amount} ${r.currency}`,
  (r) => `Notification ${r.notifId} dispatched via ${r.channel} to user ${r.userId}`,
  (r) => `Service ${r.service} started on port ${r.port} (version ${r.version})`,
  (r) => `Batch job ${r.jobName} completed: processed ${r.count} records in ${r.duration}ms`,
  (r) => `Configuration reloaded: ${r.configKey}=${r.configVal}`,
  (r) => `Health check OK for dependency ${r.dep} (latency ${r.latency}ms)`,
  // warn
  (r) => `Slow query detected (${r.duration}ms > ${r.threshold}ms): SELECT FROM ${r.table}`,
  (r) => `Rate limit approaching for user ${r.userId}: ${r.current}/${r.limit} requests`,
  (r) => `Deprecated endpoint ${r.route} called by client ${r.clientId}`,
  (r) => `Memory usage at ${r.pct}% for service ${r.service} on node ${r.nodeId}`,
  (r) => `Retry budget exhausted for task ${r.taskId} after ${r.attempts} attempts`,
  // error
  (r) => `Unhandled exception in ${r.service}: ${r.errMsg} (trace=${r.traceId})`,
  (r) => `Payment ${r.paymentId} failed: ${r.errMsg} (code=${r.errCode})`,
  (r) => `Database connection lost on node ${r.nodeId}: ${r.errMsg}`,
  (r) => `Authentication failed for user ${r.userId}: invalid credentials (ip=${r.addr})`,
];

// Severity → template index ranges
const TEMPLATE_RANGES = {
  debug: [0, 7],
  info:  [8, 14],
  warn:  [15, 19],
  error: [20, 23],
};

// Simple deterministic LCG PRNG (seed-based)
function makePrng(seed) {
  let s = seed >>> 0;
  return function next(max) {
    // LCG parameters from Numerical Recipes
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return max === undefined ? s : s % max;
  };
}

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

function buildRow(i, rng) {
  // Timestamp: spread 100k rows over 30 days (2592000 seconds)
  // Base: 2024-01-01T00:00:00Z
  const BASE_TS = 1704067200000; // ms
  const SPAN_MS = 30 * 24 * 60 * 60 * 1000;
  const tsMs = BASE_TS + Math.floor((i / 100000) * SPAN_MS) + rng(1000);
  const ts = new Date(tsMs).toISOString();

  const service = SERVICES[rng(SERVICES.length)];
  const severity = SEVERITY_TABLE[rng(100)];

  const [tMin, tMax] = TEMPLATE_RANGES[severity];
  const templateIdx = tMin + rng(tMax - tMin + 1);
  const template = MESSAGE_TEMPLATES[templateIdx];

  // Build random-ish but deterministic variables
  const r = {
    reqId:      `req-${pad(rng(0xFFFF), 5)}`,
    userId:     `usr-${pad(rng(9999), 4)}`,
    route:      ['/api/users', '/api/payments', '/api/auth', '/api/events', '/api/config'][rng(5)],
    cacheKey:   `ck:${['session', 'user', 'product', 'rate'][rng(4)]}:${rng(9999)}`,
    hit:        rng(2) === 1,
    ttl:        60 + rng(3540),
    duration:   1 + rng(4999),
    table:      ['users', 'payments', 'sessions', 'events', 'configs'][rng(5)],
    rowId:      rng(999999),
    nodeId:     `node-${pad(rng(16), 2)}`,
    addr:       `10.${rng(256)}.${rng(256)}.${rng(256)}`,
    tick:       rng(999999),
    jobName:    ['cleanup', 'report', 'sync', 'archive', 'notify'][rng(5)],
    delay:      rng(60000),
    sessionId:  `sess-${pad(rng(0xFFFFFF), 6)}`,
    valid:      rng(2) === 1,
    attempt:    1 + rng(4),
    maxAttempts: 5,
    taskId:     `task-${pad(rng(99999), 5)}`,
    bytes:      64 + rng(65472),
    authMethod: ['password', 'oauth2', 'saml', 'apikey'][rng(4)],
    paymentId:  `pay-${pad(rng(0xFFFFFF), 6)}`,
    amount:     (1 + rng(99999)) / 100,
    currency:   ['USD', 'EUR', 'GBP', 'JPY'][rng(4)],
    notifId:    `notif-${pad(rng(0xFFFF), 5)}`,
    channel:    ['email', 'sms', 'push', 'webhook'][rng(4)],
    port:       3000 + rng(3000),
    version:    `${1 + rng(3)}.${rng(20)}.${rng(100)}`,
    count:      rng(100000),
    configKey:  ['max_connections', 'timeout_ms', 'retry_limit', 'log_level'][rng(4)],
    configVal:  String(rng(9999)),
    dep:        ['postgres', 'redis', 'kafka', 'elasticsearch'][rng(4)],
    latency:    rng(500),
    threshold:  100 + rng(900),
    current:    rng(1000),
    limit:      1000,
    clientId:   `client-${pad(rng(9999), 4)}`,
    pct:        50 + rng(50),
    attempts:   3 + rng(7),
    errMsg:     ['connection refused', 'timeout exceeded', 'null pointer', 'disk full', 'permission denied'][rng(5)],
    traceId:    `trace-${pad(rng(0xFFFFFF), 6)}`,
    errCode:    ['E001', 'E002', 'E003', 'E404', 'E500'][rng(5)],
    service,
  };

  const message = template(r);
  return { ts, severity, service, message };
}

const BATCH_SIZE = 1000;
const TOTAL_ROWS = 100000;

export async function seedLogs(db) {
  const rng = makePrng(0xDEADBEEF);

  let inserted = 0;
  while (inserted < TOTAL_ROWS) {
    const batchCount = Math.min(BATCH_SIZE, TOTAL_ROWS - inserted);
    const rows = [];
    for (let i = 0; i < batchCount; i++) {
      rows.push(buildRow(inserted + i, rng));
    }

    // Build a single multi-row INSERT
    const values = rows.map((r, idx) => {
      const base = idx * 4;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
    }).join(',\n');

    const params = rows.flatMap(r => [r.ts, r.severity, r.service, r.message]);

    await db.query(
      `INSERT INTO logs (ts, severity, service, message) VALUES ${values}`,
      params
    );

    inserted += batchCount;
    if (inserted % 10000 === 0) {
      console.log(`[seed] Inserted ${inserted}/${TOTAL_ROWS} rows`);
    }
  }

  console.log(`[seed] All ${TOTAL_ROWS} rows inserted`);
}
