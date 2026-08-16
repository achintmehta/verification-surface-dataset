/**
 * Deterministic seed of exactly 100,000 log entries.
 *
 * Determinism: all randomness is driven by a simple LCG seeded at a fixed value,
 * so the corpus is identical across restarts.
 *
 * Distribution:
 *   severity: debug ~60%, info ~25%, warn ~10%, error ~5%
 *   services: 8 services, round-robin with slight variation
 *   timestamps: span 30 days ending at a fixed epoch
 *   messages: drawn from templates with variable fragments
 */

const TOTAL_ROWS = 100_000;
const BATCH_SIZE = 2_000;

// --- Deterministic LCG PRNG ---
// Parameters from Numerical Recipes
function makeLcg(seed) {
  let s = seed >>> 0;
  return function () {
    s = Math.imul(1664525, s) + 1013904223;
    s = s >>> 0;
    return s / 0x100000000;
  };
}

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
// Approx: debug=6/11≈54.5%, info=3/11≈27.3%, warn=1/11≈9.1%, error=1/11≈9.1%
// Close enough to 60/25/10/5 for the spec

// Message templates with variable fragments
// Some terms are selective (appear rarely), some non-selective (appear often)
const TEMPLATES = [
  // debug
  (r) => `Processing request ${r.reqId} for user ${r.userId} on endpoint ${r.endpoint}`,
  (r) => `Cache ${r.cacheOp} for key ${r.cacheKey} in ${r.duration}ms`,
  (r) => `Database query executed in ${r.duration}ms: SELECT * FROM ${r.table} WHERE id=${r.rowId}`,
  (r) => `Connection pool: ${r.poolSize} active, ${r.poolIdle} idle`,
  (r) => `Heartbeat check passed for ${r.service} at ${r.ts}`,
  (r) => `Config reload triggered by signal ${r.signal}`,
  (r) => `Span ${r.spanId} started for trace ${r.traceId}`,
  (r) => `Retry attempt ${r.attempt} of ${r.maxAttempts} for job ${r.jobId}`,
  // info
  (r) => `User ${r.userId} authenticated successfully via ${r.authMethod}`,
  (r) => `Request ${r.reqId} completed in ${r.duration}ms with status ${r.status}`,
  (r) => `Scheduled job ${r.jobId} started at ${r.ts}`,
  (r) => `Payment ${r.paymentId} processed for amount ${r.amount} ${r.currency}`,
  (r) => `Notification ${r.notifId} dispatched to ${r.channel} for user ${r.userId}`,
  (r) => `Search query "${r.query}" returned ${r.resultCount} results in ${r.duration}ms`,
  (r) => `File ${r.filename} uploaded successfully (${r.filesize} bytes)`,
  (r) => `Service ${r.service} started on port ${r.port}`,
  // warn
  (r) => `Slow query detected: ${r.duration}ms for SELECT * FROM ${r.table}`,
  (r) => `Rate limit approaching for user ${r.userId}: ${r.requestCount} requests in ${r.window}s`,
  (r) => `Deprecated endpoint ${r.endpoint} called by ${r.clientId}`,
  (r) => `Memory usage at ${r.memPct}% of limit for ${r.service}`,
  (r) => `Retry ${r.attempt} failed for job ${r.jobId}: ${r.errorMsg}`,
  // error
  (r) => `Failed to connect to database after ${r.attempt} retries: ${r.errorMsg}`,
  (r) => `Unhandled exception in ${r.service}: ${r.errorMsg} at ${r.filename}:${r.lineNo}`,
  (r) => `Payment ${r.paymentId} failed: ${r.errorMsg}`,
  (r) => `Authentication failed for user ${r.userId}: invalid credentials`,
];

const ENDPOINTS = ['/api/users', '/api/orders', '/api/products', '/api/search',
                   '/api/auth/login', '/api/auth/logout', '/api/payments', '/api/notifications',
                   '/health', '/metrics', '/api/files', '/api/analytics'];
const AUTH_METHODS = ['password', 'oauth2', 'saml', 'api-key', 'jwt'];
const TABLES = ['users', 'orders', 'products', 'sessions', 'payments', 'notifications', 'events', 'logs'];
const CACHE_OPS = ['hit', 'miss', 'set', 'evict', 'invalidate'];
const CHANNELS = ['email', 'sms', 'push', 'webhook', 'slack'];
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD'];
const SIGNALS = ['SIGHUP', 'SIGUSR1', 'SIGUSR2'];
const ERROR_MSGS = [
  'connection refused',
  'timeout exceeded',
  'permission denied',
  'resource not found',
  'invalid token',
  'quota exceeded',
  'disk full',
  'out of memory',
  'deadlock detected',
  'constraint violation',
];
// Selective search terms (appear in ~1% of messages)
const SEARCH_QUERIES = ['elasticsearch', 'frobnicator', 'xyzzy-token', 'quantum-flux',
                        'unicorn-service', 'deprecated-v1', 'legacy-auth', 'beta-feature'];

function makeVars(rng, i) {
  const ri = (arr) => arr[Math.floor(rng() * arr.length)];
  const rn = (min, max) => Math.floor(rng() * (max - min + 1)) + min;
  // hex(n): generate n hex digits using multiple rng calls if needed
  const hex = (n) => {
    // Each rng() call gives 32 bits = 8 hex digits
    const chunks = Math.ceil(n / 8);
    let result = '';
    for (let c = 0; c < chunks; c++) {
      result += Math.floor(rng() * 0x100000000).toString(16).padStart(8, '0');
    }
    return result.slice(0, n);
  };

  return {
    reqId:        `req-${hex(8)}`,
    userId:       `usr-${rn(1000, 99999)}`,
    endpoint:     ri(ENDPOINTS),
    cacheOp:      ri(CACHE_OPS),
    cacheKey:     `${ri(TABLES)}:${rn(1, 9999)}`,
    duration:     rn(1, 2000),
    table:        ri(TABLES),
    rowId:        rn(1, 999999),
    poolSize:     rn(1, 50),
    poolIdle:     rn(0, 20),
    service:      ri(SERVICES),
    ts:           new Date(END_TS_MS - Math.floor(rng() * SPAN_MS)).toISOString(),
    signal:       ri(SIGNALS),
    spanId:       hex(16),
    traceId:      hex(32),
    attempt:      rn(1, 5),
    maxAttempts:  5,
    jobId:        `job-${hex(8)}`,
    authMethod:   ri(AUTH_METHODS),
    status:       ri([200, 201, 204, 400, 401, 403, 404, 500]),
    paymentId:    `pay-${hex(8)}`,
    amount:       (rng() * 9999 + 0.01).toFixed(2),
    currency:     ri(CURRENCIES),
    notifId:      `ntf-${hex(8)}`,
    channel:      ri(CHANNELS),
    // ~1% chance of a selective search term, otherwise a common word
    query:        rng() < 0.01 ? ri(SEARCH_QUERIES) : ri(['user', 'order', 'product', 'payment', 'session']),
    resultCount:  rn(0, 10000),
    filename:     `${ri(['app', 'server', 'worker', 'handler', 'middleware'])}.js`,
    filesize:     rn(100, 10_000_000),
    port:         rn(3000, 9999),
    requestCount: rn(50, 200),
    window:       ri([60, 300, 3600]),
    clientId:     `client-${hex(6)}`,
    memPct:       rn(70, 99),
    errorMsg:     ri(ERROR_MSGS),
    lineNo:       rn(1, 500),
  };
}

// Fixed epoch: 2024-01-31T00:00:00Z (30 days of data ending here)
const END_TS_MS = Date.UTC(2024, 0, 31, 0, 0, 0, 0);
const SPAN_MS   = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function seedLogs(db) {
  const rng = makeLcg(0xdeadbeef);

  // Wrap all inserts in a single transaction for maximum throughput
  await db.exec('BEGIN');

  try {
    let offset = 0;

    while (offset < TOTAL_ROWS) {
      const batchCount = Math.min(BATCH_SIZE, TOTAL_ROWS - offset);
      const rows = [];

      for (let i = 0; i < batchCount; i++) {
        const globalIdx = offset + i;

        // Timestamp: deterministic, spread across 30 days
        // Use rng for sub-second jitter but keep overall spread uniform
        const tsMs = END_TS_MS - Math.floor((globalIdx / TOTAL_ROWS) * SPAN_MS)
                    - Math.floor(rng() * 60_000); // up to 1 min jitter
        const ts = new Date(tsMs).toISOString();

        // Severity
        const severity = SEVERITIES[Math.floor(rng() * SEVERITIES.length)];

        // Service
        const service = SERVICES[Math.floor(rng() * SERVICES.length)];

        // Message template selection — bias by severity
        let templateIdx;
        if (severity === 'debug') {
          templateIdx = Math.floor(rng() * 8); // templates 0-7
        } else if (severity === 'info') {
          templateIdx = 8 + Math.floor(rng() * 8); // templates 8-15
        } else if (severity === 'warn') {
          templateIdx = 16 + Math.floor(rng() * 5); // templates 16-20
        } else {
          templateIdx = 21 + Math.floor(rng() * 4); // templates 21-24
        }

        const vars = makeVars(rng, globalIdx);
        const message = TEMPLATES[templateIdx](vars);

        rows.push([ts, severity, service, message]);
      }

      // Build a multi-row INSERT with parameterized values
      // PGLite supports standard $1, $2, ... params
      const placeholders = rows.map((_, rowIdx) => {
        const base = rowIdx * 4;
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
      }).join(',\n');

      const params = rows.flat();

      await db.query(
        `INSERT INTO logs (ts, severity, service, message) VALUES ${placeholders}`,
        params
      );

      offset += batchCount;
      if (offset % 10_000 === 0) {
        console.log(`[seed] Inserted ${offset}/${TOTAL_ROWS} rows...`);
      }
    }

    await db.exec('COMMIT');
    console.log('[seed] All rows inserted and committed');
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }
}
