/**
 * Deterministic seed of 100,000 log entries.
 *
 * Determinism: every value is derived from the row index via a simple
 * LCG-style hash so the corpus is identical across restarts.
 *
 * Distribution targets:
 *   severity: debug ~60%, info ~25%, warn ~10%, error ~5%
 *   services: 8 services, roughly uniform
 *   timestamps: 30-day window ending at a fixed epoch
 *   messages: drawn from templates with variable fragments so substring
 *             search has both selective (rare) and non-selective (common) terms
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

// Severity distribution: ~60% debug, ~25% info, ~10% warn, ~5% error
const SEVERITY_WEIGHTS = [
  { sev: 'debug', weight: 60 },
  { sev: 'info',  weight: 25 },
  { sev: 'warn',  weight: 10 },
  { sev: 'error', weight:  5 },
];
const SEVERITY_LIST = [];
for (const { sev, weight } of SEVERITY_WEIGHTS) {
  for (let i = 0; i < weight; i++) SEVERITY_LIST.push(sev);
}

// Message templates — mix of selective and non-selective terms
const MESSAGE_TEMPLATES = [
  // debug templates
  (v) => `Cache lookup for key="${v.key}" returned ${v.hit ? 'HIT' : 'MISS'} in ${v.ms}ms`,
  (v) => `DB query executed: table=${v.table} rows_scanned=${v.rows} duration=${v.ms}ms`,
  (v) => `HTTP request received method=${v.method} path=${v.path} user_agent="${v.ua}"`,
  (v) => `Session token validated for user_id=${v.uid} session=${v.session}`,
  (v) => `Config reload triggered by signal SIGHUP, reloading ${v.count} keys`,
  (v) => `Heartbeat ping to ${v.host}:${v.port} latency=${v.ms}ms`,
  (v) => `Queue depth for topic="${v.topic}" is ${v.depth} messages`,
  (v) => `Retry attempt ${v.attempt} of ${v.max} for job_id=${v.job}`,
  // info templates
  (v) => `User ${v.uid} logged in from IP ${v.ip} using ${v.method} auth`,
  (v) => `Order ${v.order} placed by user ${v.uid} total=$${v.amount}`,
  (v) => `Service started on port ${v.port} environment=${v.env}`,
  (v) => `Scheduled job "${v.job}" completed in ${v.ms}ms processed=${v.count} records`,
  (v) => `Feature flag "${v.flag}" evaluated to ${v.val} for user ${v.uid}`,
  (v) => `Email notification sent to ${v.email} template="${v.tmpl}"`,
  // warn templates
  (v) => `Slow query detected: ${v.ms}ms threshold=500ms query_hash=${v.hash}`,
  (v) => `Rate limit approaching for client ${v.ip}: ${v.count}/${v.max} requests`,
  (v) => `Deprecated API endpoint /v1/${v.path} called by ${v.ua}`,
  (v) => `Memory usage at ${v.pct}% of limit on instance ${v.inst}`,
  (v) => `Connection pool exhausted for ${v.db}: waiting ${v.ms}ms`,
  // error templates
  (v) => `FATAL: unhandled exception in ${v.svc} error="${v.err}" stack_trace_id=${v.trace}`,
  (v) => `Payment processing failed for order ${v.order}: ${v.reason}`,
  (v) => `Database connection lost to ${v.host}: ${v.err}`,
  (v) => `Authentication failure for user ${v.uid} from IP ${v.ip} reason="${v.reason}"`,
];

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
const PATHS = ['/users', '/orders', '/products', '/auth/login', '/auth/logout',
               '/payments', '/notifications', '/inventory', '/search', '/analytics'];
const TABLES = ['users', 'orders', 'products', 'sessions', 'payments', 'events'];
const TOPICS = ['user.created', 'order.placed', 'payment.processed', 'notification.sent'];
const ENVS = ['production', 'staging'];
const FLAGS = ['new-checkout', 'dark-mode', 'beta-search', 'v2-api', 'experimental-cache'];
const TEMPLATES_EMAIL = ['welcome', 'password-reset', 'order-confirm', 'invoice', 'promo'];
const ERRORS = [
  'connection refused',
  'timeout after 30s',
  'null pointer dereference',
  'disk quota exceeded',
  'permission denied',
  'invalid JSON payload',
];
const REASONS = [
  'card declined',
  'insufficient funds',
  'expired card',
  'fraud detected',
  'invalid CVV',
];

// Simple deterministic pseudo-random number generator (xorshift32)
function makeRng(seed) {
  let s = seed >>> 0;
  if (s === 0) s = 1;
  return function () {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function randIp(rng) {
  return `${randInt(rng,1,254)}.${randInt(rng,0,255)}.${randInt(rng,0,255)}.${randInt(rng,1,254)}`;
}

function randHex(rng, len) {
  let h = '';
  for (let i = 0; i < len; i++) h += Math.floor(rng() * 16).toString(16);
  return h;
}

// Fixed epoch: 2024-01-31T00:00:00Z (30 days window: 2024-01-01 to 2024-01-31)
const WINDOW_END_MS   = Date.UTC(2024, 0, 31, 0, 0, 0);
const WINDOW_START_MS = Date.UTC(2024, 0,  1, 0, 0, 0);
const WINDOW_RANGE_MS = WINDOW_END_MS - WINDOW_START_MS;

function generateRow(i) {
  const rng = makeRng(i * 2654435761 + 1);

  // Timestamp: deterministic within 30-day window
  const tsMs = WINDOW_START_MS + Math.floor(rng() * WINDOW_RANGE_MS);
  const ts = new Date(tsMs).toISOString();

  // Severity
  const severity = SEVERITY_LIST[Math.floor(rng() * SEVERITY_LIST.length)];

  // Service
  const service = pick(rng, SERVICES);

  // Message
  const tmplIdx = Math.floor(rng() * MESSAGE_TEMPLATES.length);
  const tmpl = MESSAGE_TEMPLATES[tmplIdx];

  const vars = {
    key:     `${pick(rng, TABLES)}:${randInt(rng, 1, 99999)}`,
    hit:     rng() > 0.4,
    ms:      randInt(rng, 1, 2000),
    table:   pick(rng, TABLES),
    rows:    randInt(rng, 1, 50000),
    method:  pick(rng, METHODS),
    path:    pick(rng, PATHS),
    ua:      `Mozilla/5.0 (service-client/${randInt(rng,1,9)}.${randInt(rng,0,9)})`,
    uid:     randInt(rng, 1000, 999999),
    session: randHex(rng, 16),
    count:   randInt(rng, 1, 500),
    host:    `db-${randInt(rng, 1, 8)}.internal`,
    port:    pick(rng, [5432, 6379, 9200, 8080, 3000]),
    depth:   randInt(rng, 0, 10000),
    topic:   pick(rng, TOPICS),
    attempt: randInt(rng, 1, 5),
    max:     5,
    job:     `job-${randHex(rng, 8)}`,
    ip:      randIp(rng),
    order:   `ORD-${randInt(rng, 100000, 999999)}`,
    amount:  (rng() * 9999 + 1).toFixed(2),
    env:     pick(rng, ENVS),
    flag:    pick(rng, FLAGS),
    val:     rng() > 0.5 ? 'true' : 'false',
    email:   `user${randInt(rng, 1000, 99999)}@example.com`,
    tmpl:    pick(rng, TEMPLATES_EMAIL),
    hash:    randHex(rng, 12),
    pct:     randInt(rng, 70, 99),
    inst:    `i-${randHex(rng, 8)}`,
    db:      `${pick(rng, TABLES)}-db`,
    svc:     pick(rng, SERVICES),
    err:     pick(rng, ERRORS),
    trace:   randHex(rng, 16),
    reason:  pick(rng, REASONS),
  };

  const message = tmpl(vars);

  return { ts, severity, service, message };
}

export async function seedIfNeeded(db) {
  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*) as cnt FROM logs');
  const existing = parseInt(countResult.rows[0].cnt, 10);

  if (existing >= TOTAL_ROWS) {
    console.log(`[seed] Table already has ${existing} rows — skipping seed.`);
    return;
  }

  if (existing > 0) {
    console.log(`[seed] Partial seed detected (${existing} rows) — truncating and reseeding.`);
    await db.query('TRUNCATE logs');
  }

  console.log(`[seed] Seeding ${TOTAL_ROWS} rows in batches of ${BATCH_SIZE}...`);
  const t0 = Date.now();

  for (let batchStart = 0; batchStart < TOTAL_ROWS; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL_ROWS);
    const rows = [];
    for (let i = batchStart; i < batchEnd; i++) {
      rows.push(generateRow(i));
    }

    // Build a multi-row INSERT
    const values = [];
    const params = [];
    let paramIdx = 1;
    for (const row of rows) {
      values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
      params.push(row.ts, row.severity, row.service, row.message);
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')}`;
    await db.query(sql, params);

    if ((batchStart / BATCH_SIZE + 1) % 10 === 0) {
      console.log(`[seed] Inserted ${batchEnd} / ${TOTAL_ROWS} rows...`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[seed] Done. Seeded ${TOTAL_ROWS} rows in ${elapsed}s.`);
}
