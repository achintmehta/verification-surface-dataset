/**
 * Deterministic seed of 100,000 log entries.
 * Uses a simple LCG PRNG so results are identical across restarts.
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
  { level: 'info',  weight: 60 },
  { level: 'debug', weight: 25 },
  { level: 'warn',  weight: 10 },
  { level: 'error', weight:  5 },
];

const SEVERITY_CUMULATIVE = [];
let cumSum = 0;
for (const s of SEVERITY_WEIGHTS) {
  cumSum += s.weight;
  SEVERITY_CUMULATIVE.push({ level: s.level, cum: cumSum });
}
const SEVERITY_TOTAL = cumSum; // 100

// Message templates with variable fragments
// Some terms are selective (rare), some non-selective (common)
const MESSAGE_TEMPLATES = [
  // info templates
  (r) => `Request processed successfully in ${r.ms}ms for user ${r.userId}`,
  (r) => `Cache hit for key session:${r.sessionId} latency=${r.ms}ms`,
  (r) => `User ${r.userId} logged in from ${r.ip}`,
  (r) => `Health check passed for endpoint ${r.endpoint}`,
  (r) => `Batch job completed: processed ${r.count} records`,
  (r) => `Configuration reloaded from remote source version=${r.version}`,
  (r) => `Connection pool size adjusted to ${r.count} connections`,
  (r) => `Token refreshed for user ${r.userId} expires_in=${r.ms}s`,
  // debug templates
  (r) => `SQL query executed in ${r.ms}ms rows_affected=${r.count}`,
  (r) => `Cache miss for key inventory:${r.itemId} fetching from DB`,
  (r) => `Retry attempt ${r.count} for request to ${r.endpoint}`,
  (r) => `Deserialized payload size=${r.count} bytes from queue`,
  (r) => `Feature flag ${r.flag} evaluated to ${r.bool} for user ${r.userId}`,
  (r) => `Span ${r.sessionId} started for trace ${r.traceId}`,
  // warn templates
  (r) => `Slow query detected: ${r.ms}ms exceeds threshold for ${r.endpoint}`,
  (r) => `Rate limit approaching for user ${r.userId}: ${r.count}/1000 requests`,
  (r) => `Deprecated API endpoint ${r.endpoint} called by ${r.ip}`,
  (r) => `Memory usage at ${r.count}% of limit on instance ${r.instanceId}`,
  (r) => `Circuit breaker half-open for service ${r.endpoint}`,
  // error templates
  (r) => `Failed to connect to database after ${r.count} retries: timeout`,
  (r) => `Unhandled exception in ${r.endpoint}: NullPointerException at line ${r.count}`,
  (r) => `Payment processing failed for order ${r.orderId}: declined`,
  (r) => `Authentication token invalid for user ${r.userId}: signature mismatch`,
  (r) => `Critical: disk usage at ${r.count}% on instance ${r.instanceId}`,
];

// LCG parameters (Numerical Recipes)
const LCG_A = 1664525;
const LCG_C = 1013904223;
const LCG_M = 2 ** 32;

function makePrng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = ((LCG_A * state + LCG_C) >>> 0);
    return state / LCG_M;
  };
}

function pickSeverity(rand) {
  const v = rand() * SEVERITY_TOTAL;
  for (const s of SEVERITY_CUMULATIVE) {
    if (v < s.cum) return s.level;
  }
  return 'info';
}

function randInt(rand, min, max) {
  return Math.floor(rand() * (max - min + 1)) + min;
}

function randChoice(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

function randIp(rand) {
  return `${randInt(rand,1,254)}.${randInt(rand,0,255)}.${randInt(rand,0,255)}.${randInt(rand,1,254)}`;
}

function randHex(rand, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += Math.floor(rand() * 16).toString(16);
  }
  return s;
}

const FLAGS = ['dark-mode', 'new-checkout', 'beta-search', 'experimental-cache', 'v2-api'];
const ENDPOINTS = [
  '/api/users', '/api/orders', '/api/products', '/api/auth/login',
  '/api/payments', '/api/search', '/api/inventory', '/api/notifications',
  '/health', '/metrics',
];

function generateRow(i, rand) {
  const severity = pickSeverity(rand);

  // Deterministic timestamp: spread 100k rows over 30 days
  // Base: 30 days ago from a fixed epoch (2024-01-01T00:00:00Z = 1704067200000)
  const BASE_TS = 1704067200000;
  const SPAN_MS = 30 * 24 * 60 * 60 * 1000;
  // Use row index for primary ordering, add small jitter
  const jitter = Math.floor(rand() * 60000); // up to 1 minute jitter
  const ts = new Date(BASE_TS + Math.floor((i / TOTAL_ROWS) * SPAN_MS) + jitter);

  const vars = {
    ms:         randInt(rand, 1, 5000),
    userId:     `u${randInt(rand, 1000, 9999)}`,
    sessionId:  randHex(rand, 8),
    traceId:    randHex(rand, 16),
    ip:         randIp(rand),
    endpoint:   randChoice(rand, ENDPOINTS),
    count:      randInt(rand, 1, 999),
    version:    `${randInt(rand,1,5)}.${randInt(rand,0,20)}.${randInt(rand,0,99)}`,
    itemId:     `item-${randInt(rand, 10000, 99999)}`,
    flag:       randChoice(rand, FLAGS),
    bool:       rand() > 0.5 ? 'true' : 'false',
    instanceId: `i-${randHex(rand, 8)}`,
    orderId:    `ord-${randInt(rand, 100000, 999999)}`,
  };

  // Pick template based on severity
  let templatePool;
  if (severity === 'info')       templatePool = MESSAGE_TEMPLATES.slice(0, 8);
  else if (severity === 'debug') templatePool = MESSAGE_TEMPLATES.slice(8, 14);
  else if (severity === 'warn')  templatePool = MESSAGE_TEMPLATES.slice(14, 19);
  else                           templatePool = MESSAGE_TEMPLATES.slice(19);

  const template = templatePool[Math.floor(rand() * templatePool.length)];
  const message = template(vars);
  const service = SERVICES[i % SERVICES.length];

  return { ts: ts.toISOString(), severity, service, message };
}

export async function seedIfNeeded(db) {
  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*) as cnt FROM logs');
  const existing = parseInt(countResult.rows[0].cnt, 10);

  if (existing >= TOTAL_ROWS) {
    console.log(`[seed] Table already has ${existing} rows, skipping seed.`);
    return;
  }

  if (existing > 0) {
    console.log(`[seed] Partial seed detected (${existing} rows), truncating and reseeding.`);
    await db.query('TRUNCATE TABLE logs');
  }

  console.log(`[seed] Seeding ${TOTAL_ROWS} rows...`);
  const startTime = Date.now();

  const rand = makePrng(42);
  const BATCH_SIZE = 1000;

  for (let batchStart = 0; batchStart < TOTAL_ROWS; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL_ROWS);
    const rows = [];

    for (let i = batchStart; i < batchEnd; i++) {
      rows.push(generateRow(i, rand));
    }

    // Build a multi-row INSERT
    const valuePlaceholders = [];
    const params = [];
    let paramIdx = 1;

    for (const row of rows) {
      valuePlaceholders.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
      params.push(row.ts, row.severity, row.service, row.message);
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${valuePlaceholders.join(', ')}`;
    await db.query(sql, params);

    if ((batchStart / BATCH_SIZE) % 20 === 0) {
      console.log(`[seed] Inserted ${batchEnd}/${TOTAL_ROWS} rows...`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[seed] Done. Seeded ${TOTAL_ROWS} rows in ${elapsed}s.`);
}
