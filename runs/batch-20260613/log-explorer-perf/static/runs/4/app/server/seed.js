/**
 * Deterministic seed: 100,000 log rows spanning 30 days across 8 services.
 * Severity distribution: ~60% debug, ~25% info, ~10% warn, ~5% error.
 * Messages drawn from templates with variable fragments so substring search
 * has both selective and non-selective terms.
 */

const TOTAL_ROWS = 100_000;
const BATCH_SIZE = 2_000;

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

// Severity distribution: ~60% debug, ~25% info, ~10% warn, ~5% error
const SEVERITY_WEIGHTS = [
  { sev: 'debug', weight: 60 },
  { sev: 'info',  weight: 25 },
  { sev: 'warn',  weight: 10 },
  { sev: 'error', weight: 5  },
];

// Build a lookup array for O(1) weighted random
const SEVERITY_TABLE = [];
for (const { sev, weight } of SEVERITY_WEIGHTS) {
  for (let i = 0; i < weight; i++) SEVERITY_TABLE.push(sev);
}
// SEVERITY_TABLE.length === 100

// Message templates — mix of selective (unique-ish) and non-selective (common) terms
const MESSAGE_TEMPLATES = [
  // Non-selective (common terms: "request", "response", "connection")
  (r) => `Received request for endpoint /api/v${r.v}/resource/${r.id} from ${r.ip}`,
  (r) => `Sending response with status ${r.status} for request ${r.reqId}`,
  (r) => `Connection established to ${r.host}:${r.port} (pool size: ${r.pool})`,
  (r) => `Connection closed for session ${r.session} after ${r.ms}ms`,
  (r) => `Processing request batch of ${r.batch} items for tenant ${r.tenant}`,
  // Selective (unique-ish terms: specific error codes, trace IDs)
  (r) => `TraceID=${r.trace} span=${r.span} operation=fetchUser latency=${r.ms}ms`,
  (r) => `Cache ${r.hit ? 'HIT' : 'MISS'} for key user:${r.userId}:profile ttl=${r.ttl}s`,
  (r) => `Database query executed in ${r.ms}ms rows_returned=${r.rows} query_hash=${r.hash}`,
  (r) => `Authentication token validated for subject=${r.sub} issuer=${r.iss} exp=${r.exp}`,
  (r) => `Rate limit check: tenant=${r.tenant} bucket=${r.bucket} remaining=${r.remaining}`,
  (r) => `Scheduled job ${r.jobName} started at ${r.tsStr} with params ${JSON.stringify({ id: r.id })}`,
  (r) => `Scheduled job ${r.jobName} completed in ${r.ms}ms processed=${r.rows} failed=${r.failed}`,
  (r) => `Circuit breaker OPEN for service=${r.svc} failure_rate=${r.rate}% threshold=50%`,
  (r) => `Circuit breaker CLOSED for service=${r.svc} after ${r.ms}ms recovery`,
  (r) => `Retry attempt ${r.attempt}/3 for operation=${r.op} error=${r.errCode}`,
  (r) => `Payload deserialization failed: expected JSON got ${r.contentType} size=${r.size}b`,
  (r) => `Health check passed: db_latency=${r.ms}ms cache_latency=${r.ms2}ms`,
  (r) => `Health check FAILED: component=${r.component} reason=${r.reason}`,
  (r) => `Metric emitted: name=${r.metric} value=${r.value} tags=${r.tags}`,
  (r) => `Config reloaded: changed_keys=${r.keys} version=${r.version}`,
];

const JOB_NAMES = ['cleanup-expired-sessions', 'reindex-search', 'send-digest-emails',
                   'archive-old-logs', 'refresh-materialized-views', 'sync-billing-records'];
const OPERATIONS = ['fetchUser', 'updateProfile', 'deleteSession', 'createOrder', 'processPayment'];
const ERROR_CODES = ['ERR_TIMEOUT', 'ERR_CONN_REFUSED', 'ERR_RATE_LIMITED', 'ERR_AUTH_FAILED', 'ERR_NOT_FOUND'];
const COMPONENTS = ['postgres', 'redis', 'elasticsearch', 'kafka', 'smtp'];
const REASONS = ['connection_timeout', 'auth_failure', 'disk_full', 'oom', 'max_connections'];
const METRICS = ['http_requests_total', 'db_query_duration_ms', 'cache_hit_ratio', 'active_connections', 'queue_depth'];
const ISSUERS = ['auth.internal', 'oauth.provider', 'sso.corp'];

// Simple deterministic LCG pseudo-random number generator
function makeLCG(seed) {
  let s = seed >>> 0;
  return function () {
    s = Math.imul(1664525, s) + 1013904223;
    s = s >>> 0;
    return s / 0x100000000;
  };
}

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function randChoice(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function randIp(rng) {
  return `${randInt(rng, 10, 192)}.${randInt(rng, 0, 255)}.${randInt(rng, 0, 255)}.${randInt(rng, 1, 254)}`;
}

function randHex(rng, len) {
  let h = '';
  for (let i = 0; i < len; i++) h += Math.floor(rng() * 16).toString(16);
  return h;
}

function buildRow(i, rng) {
  // Deterministic timestamp: spread 100k rows over 30 days (2,592,000 seconds)
  // Base: 2024-01-01T00:00:00Z
  const BASE_TS = 1704067200000; // ms
  const SPAN_MS = 30 * 24 * 60 * 60 * 1000;
  // Use index-based spacing with small jitter for realism
  const fraction = i / TOTAL_ROWS;
  const jitter = (rng() - 0.5) * 60000; // ±30s jitter
  const tsMs = BASE_TS + Math.floor(fraction * SPAN_MS + jitter);
  const ts = new Date(tsMs).toISOString();

  const severity = SEVERITY_TABLE[Math.floor(rng() * 100)];
  const service = SERVICES[i % SERVICES.length];

  const r = {
    v:           randInt(rng, 1, 3),
    id:          randInt(rng, 1000, 999999),
    ip:          randIp(rng),
    status:      randChoice(rng, [200, 201, 204, 400, 401, 403, 404, 500, 502, 503]),
    reqId:       randHex(rng, 16),
    host:        randChoice(rng, ['db-primary', 'db-replica-1', 'db-replica-2', 'cache-1', 'cache-2']),
    port:        randChoice(rng, [5432, 6379, 9200, 9092]),
    pool:        randInt(rng, 1, 20),
    session:     randHex(rng, 12),
    ms:          randInt(rng, 1, 2000),
    ms2:         randInt(rng, 1, 50),
    batch:       randInt(rng, 1, 500),
    tenant:      `tenant-${randInt(rng, 1, 50)}`,
    trace:       randHex(rng, 32),
    span:        randHex(rng, 16),
    hit:         rng() > 0.3,
    userId:      randInt(rng, 1, 100000),
    ttl:         randInt(rng, 60, 3600),
    rows:        randInt(rng, 0, 10000),
    hash:        randHex(rng, 8),
    sub:         `user:${randInt(rng, 1, 100000)}`,
    iss:         randChoice(rng, ISSUERS),
    exp:         Math.floor(tsMs / 1000) + randInt(rng, 300, 86400),
    bucket:      `${randChoice(rng, ['read', 'write', 'admin'])}:${randInt(rng, 1, 10)}`,
    remaining:   randInt(rng, 0, 1000),
    jobName:     randChoice(rng, JOB_NAMES),
    tsStr:       ts,
    failed:      randInt(rng, 0, 10),
    svc:         randChoice(rng, SERVICES),
    rate:        randInt(rng, 50, 100),
    attempt:     randInt(rng, 1, 3),
    op:          randChoice(rng, OPERATIONS),
    errCode:     randChoice(rng, ERROR_CODES),
    contentType: randChoice(rng, ['text/plain', 'application/xml', 'multipart/form-data']),
    size:        randInt(rng, 100, 100000),
    component:   randChoice(rng, COMPONENTS),
    reason:      randChoice(rng, REASONS),
    metric:      randChoice(rng, METRICS),
    value:       (rng() * 1000).toFixed(2),
    tags:        `env=prod,region=us-east-${randInt(rng, 1, 3)}`,
    keys:        randInt(rng, 1, 10),
    version:     `${randInt(rng, 1, 5)}.${randInt(rng, 0, 20)}.${randInt(rng, 0, 99)}`,
  };

  const templateFn = MESSAGE_TEMPLATES[i % MESSAGE_TEMPLATES.length];
  const message = templateFn(r);

  return { ts, severity, service, message };
}

export async function seedLogs(db) {
  const rng = makeLCG(42);

  // Build all rows first (fast, in-memory)
  console.log('[seed] Generating row data...');
  const rows = [];
  for (let i = 0; i < TOTAL_ROWS; i++) {
    rows.push(buildRow(i, rng));
  }

  console.log(`[seed] Inserting ${TOTAL_ROWS} rows in batches of ${BATCH_SIZE}...`);

  for (let offset = 0; offset < TOTAL_ROWS; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);

    // Build a multi-row VALUES clause
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (const row of batch) {
      values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
      params.push(row.ts, row.severity, row.service, row.message);
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')}`;
    await db.query(sql, params);

    if ((offset / BATCH_SIZE) % 10 === 0) {
      console.log(`[seed] Inserted ${Math.min(offset + BATCH_SIZE, TOTAL_ROWS)} / ${TOTAL_ROWS}`);
    }
  }

  console.log('[seed] All rows inserted');
}
