/**
 * Deterministic seed: 100,000 log entries spanning 30 days across 8 services.
 * Severity distribution: ~60% debug, ~25% info, ~10% warn, ~5% error.
 * Messages drawn from templates with variable fragments for selective/non-selective search.
 */

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

// Weighted severity table: 60 debug, 25 info, 10 warn, 5 error = 100 entries
const SEVERITY_TABLE = [];
const SEVERITY_WEIGHTS = [
  { sev: 'debug', weight: 60 },
  { sev: 'info',  weight: 25 },
  { sev: 'warn',  weight: 10 },
  { sev: 'error', weight: 5  },
];
for (const { sev, weight } of SEVERITY_WEIGHTS) {
  for (let i = 0; i < weight; i++) SEVERITY_TABLE.push(sev);
}

// Message templates — mix of selective (unique-ish) and non-selective (common) terms
const MESSAGE_TEMPLATES = [
  // debug (indices 0-7)
  (r) => `Processing request ${r.reqId} for user ${r.userId} on endpoint ${r.endpoint}`,
  (r) => `Cache lookup for key ${r.cacheKey}: ${r.hit ? 'HIT' : 'MISS'}`,
  (r) => `Database query executed in ${r.duration}ms: SELECT * FROM ${r.table} WHERE id=${r.rowId}`,
  (r) => `Heartbeat ping from ${r.host} latency=${r.latency}ms`,
  (r) => `Token validation completed for session ${r.sessionId}`,
  (r) => `Retry attempt ${r.attempt} of ${r.maxAttempts} for job ${r.jobId}`,
  (r) => `Serializing response payload size=${r.size} bytes for request ${r.reqId}`,
  (r) => `Config reload triggered by watcher on file ${r.configFile}`,
  // info (indices 8-13)
  (r) => `User ${r.userId} logged in from ${r.ip} using ${r.authMethod}`,
  (r) => `Order ${r.orderId} created for user ${r.userId} total=${r.amount}`,
  (r) => `Scheduled job ${r.jobId} started at ${r.startTime}`,
  (r) => `File ${r.filename} uploaded successfully size=${r.size} bytes`,
  (r) => `Service ${r.service} connected to database host=${r.dbHost}`,
  (r) => `Deployment ${r.deployId} completed successfully version=${r.version}`,
  // warn (indices 14-18)
  (r) => `High memory usage detected: ${r.memPct}% on host ${r.host}`,
  (r) => `Slow query detected (${r.duration}ms): SELECT * FROM ${r.table}`,
  (r) => `Rate limit approaching for user ${r.userId}: ${r.reqCount} requests in last minute`,
  (r) => `Deprecated API endpoint ${r.endpoint} called by ${r.ip}`,
  (r) => `Connection pool exhausted for database ${r.dbHost}, queuing request`,
  // error (indices 19-22)
  (r) => `Failed to process payment for order ${r.orderId}: ${r.errorCode}`,
  (r) => `Unhandled exception in ${r.service}: ${r.errorMsg}`,
  (r) => `Authentication failed for user ${r.userId} from ${r.ip}: invalid credentials`,
  (r) => `Timeout waiting for response from ${r.upstream} after ${r.duration}ms`,
];

// Simple deterministic PRNG (mulberry32)
function makePrng(seed) {
  let s = seed >>> 0;
  return function () {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function randChoice(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function buildVars(rng, i) {
  return {
    reqId:      `req-${(i * 7919 + 1) % 999999}`,
    userId:     `usr-${randInt(rng, 1, 5000)}`,
    orderId:    `ord-${randInt(rng, 10000, 99999)}`,
    jobId:      `job-${randInt(rng, 100, 9999)}`,
    sessionId:  `sess-${(i * 3571) % 99999}`,
    deployId:   `dep-${randInt(rng, 1, 500)}`,
    cacheKey:   `ck:${randChoice(rng, ['user', 'product', 'session', 'config'])}:${randInt(rng, 1, 10000)}`,
    endpoint:   randChoice(rng, ['/api/users', '/api/orders', '/api/products', '/api/auth', '/api/search', '/api/payments']),
    table:      randChoice(rng, ['users', 'orders', 'products', 'sessions', 'events', 'logs']),
    host:       `host-${randInt(rng, 1, 20)}.internal`,
    dbHost:     `db-${randInt(rng, 1, 4)}.internal`,
    upstream:   randChoice(rng, ['payment-gateway', 'email-provider', 'sms-provider', 'cdn']),
    ip:         `${randInt(rng,10,192)}.${randInt(rng,0,255)}.${randInt(rng,0,255)}.${randInt(rng,1,254)}`,
    authMethod: randChoice(rng, ['password', 'oauth2', 'saml', 'api-key']),
    configFile: randChoice(rng, ['app.yaml', 'db.yaml', 'cache.yaml', 'feature-flags.json']),
    filename:   `file-${randInt(rng, 1000, 9999)}.${randChoice(rng, ['pdf', 'csv', 'json', 'png'])}`,
    version:    `v${randInt(rng,1,5)}.${randInt(rng,0,20)}.${randInt(rng,0,99)}`,
    errorCode:  randChoice(rng, ['INSUFFICIENT_FUNDS', 'CARD_DECLINED', 'NETWORK_ERROR', 'TIMEOUT', 'INVALID_CARD']),
    errorMsg:   randChoice(rng, ['NullPointerException', 'ConnectionRefused', 'OutOfMemoryError', 'StackOverflow', 'AssertionError']),
    rowId:      randInt(rng, 1, 1000000),
    duration:   randInt(rng, 1, 5000),
    latency:    randInt(rng, 1, 200),
    size:       randInt(rng, 100, 10000000),
    attempt:    randInt(rng, 1, 5),
    maxAttempts: 5,
    memPct:     randInt(rng, 70, 99),
    reqCount:   randInt(rng, 50, 200),
    amount:     (randInt(rng, 100, 100000) / 100).toFixed(2),
    hit:        rng() > 0.4,
    service:    '',   // filled in below
    startTime:  '00:00:00',
  };
}

const TOTAL_ROWS = 100000;
// Batch size: 500 rows × 4 params = 2000 params — well within PGLite limits
const BATCH_SIZE = 500;

// 30 days span in milliseconds
const SPAN_MS = 30 * 24 * 60 * 60 * 1000;
// Fixed reference point for determinism
const BASE_TS = new Date('2024-01-01T00:00:00.000Z').getTime();

export async function seed(db) {
  const rng = makePrng(0xdeadbeef);

  // Pre-generate all rows in memory
  const rows = [];
  for (let i = 0; i < TOTAL_ROWS; i++) {
    const tsMs    = BASE_TS + Math.floor(rng() * SPAN_MS);
    const ts      = new Date(tsMs).toISOString();
    const severity = SEVERITY_TABLE[Math.floor(rng() * SEVERITY_TABLE.length)];
    const service  = SERVICES[Math.floor(rng() * SERVICES.length)];
    const vars     = buildVars(rng, i);
    vars.service   = service;
    const templateIdx = Math.floor(rng() * MESSAGE_TEMPLATES.length);
    const message  = MESSAGE_TEMPLATES[templateIdx](vars);
    rows.push({ ts, severity, service, message });
  }

  // Insert in batches using parameterized queries
  let inserted = 0;
  while (inserted < rows.length) {
    const batch = rows.slice(inserted, inserted + BATCH_SIZE);

    // Build VALUES clause: ($1,$2,$3,$4), ($5,$6,$7,$8), ...
    const valueClauses = batch.map((_, j) => {
      const base = j * 4;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
    });
    const params = batch.flatMap((r) => [r.ts, r.severity, r.service, r.message]);

    await db.query(
      `INSERT INTO logs (ts, severity, service, message) VALUES ${valueClauses.join(',')}`,
      params
    );

    inserted += batch.length;
    if (inserted % 10000 === 0) {
      console.log(`[seed] Inserted ${inserted}/${TOTAL_ROWS} rows…`);
    }
  }

  console.log(`[seed] Done. Total rows inserted: ${inserted}`);
}
