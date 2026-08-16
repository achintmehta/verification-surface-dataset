// Deterministic seed generation for the log corpus.
// Exactly 100,000 rows across 30 days, 8 services, severities ~60/25/10/5.

export const TOTAL_ROWS = 100000;
export const SERVICES = [
  'auth-service',
  'billing-service',
  'gateway',
  'inventory',
  'notifications',
  'payments',
  'search-indexer',
  'user-profile',
];

export const SEVERITIES = ['debug', 'info', 'warn', 'error'];

// Message templates with variable fragments. Some fragments are selective
// (appear in few messages) and some are non-selective (appear frequently).
const TEMPLATES = [
  'Request handled for endpoint {endpoint} in {ms}ms',
  'User {userId} performed action {action}',
  'Cache {cacheKey} {cacheResult}',
  'Database query on table {table} took {ms}ms',
  'Connection to {peer} {connState}',
  'Processing job {jobId} status {jobStatus}',
  'Validation of {resource} {validation}',
  'Retrying {operation} attempt {attempt}',
];

const ENDPOINTS = ['/api/orders', '/api/users', '/api/search', '/api/checkout', '/api/health'];
const ACTIONS = ['login', 'logout', 'update-profile', 'delete-account', 'change-password'];
const CACHE_RESULTS = ['hit', 'miss', 'evicted', 'stale'];
const TABLES = ['orders', 'users', 'sessions', 'invoices', 'events'];
const CONN_STATES = ['established', 'closed', 'timed out', 'refused'];
const JOB_STATUSES = ['queued', 'running', 'completed', 'failed'];
const VALIDATIONS = ['passed', 'failed', 'skipped'];
const OPERATIONS = ['fetch', 'commit', 'rollback', 'sync'];
// A deliberately rare / selective fragment inserted occasionally.
const RARE_TAGS = ['[CRITICAL-PATH]', '[QUANTUM-FLUX]', '[legacy-shim]'];

// A tiny deterministic PRNG (mulberry32) so the corpus is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

// Severity distribution ~60/25/10/5 (info/debug? ). Spec: 60/25/10/5.
// Interpreting as info 60, debug 25, warn 10, error 5.
function pickSeverity(rng) {
  const r = rng();
  if (r < 0.6) return 'info';
  if (r < 0.85) return 'debug';
  if (r < 0.95) return 'warn';
  return 'error';
}

function buildMessage(rng) {
  const template = pick(rng, TEMPLATES);
  let msg = template
    .replace('{endpoint}', pick(rng, ENDPOINTS))
    .replace('{ms}', String(Math.floor(rng() * 900) + 1))
    .replace('{userId}', 'u' + Math.floor(rng() * 100000))
    .replace('{action}', pick(rng, ACTIONS))
    .replace('{cacheKey}', 'k' + Math.floor(rng() * 5000))
    .replace('{cacheResult}', pick(rng, CACHE_RESULTS))
    .replace('{table}', pick(rng, TABLES))
    .replace('{peer}', '10.0.' + Math.floor(rng() * 255) + '.' + Math.floor(rng() * 255))
    .replace('{connState}', pick(rng, CONN_STATES))
    .replace('{jobId}', 'job-' + Math.floor(rng() * 50000))
    .replace('{jobStatus}', pick(rng, JOB_STATUSES))
    .replace('{resource}', pick(rng, TABLES))
    .replace('{validation}', pick(rng, VALIDATIONS))
    .replace('{operation}', pick(rng, OPERATIONS))
    .replace('{attempt}', String(Math.floor(rng() * 5) + 1));
  // ~2% of messages get a rare tag for selective-substring testing.
  if (rng() < 0.02) {
    msg = pick(rng, RARE_TAGS) + ' ' + msg;
  }
  return msg;
}

// Yields row objects deterministically. ts spans 30 days ending "now" anchor.
// We use a fixed anchor so restarts produce identical timestamps.
const ANCHOR_MS = Date.UTC(2024, 0, 31, 0, 0, 0); // 2024-01-31T00:00:00Z
const SPAN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function* generateRows() {
  const rng = mulberry32(0x1234abcd);
  for (let i = 0; i < TOTAL_ROWS; i++) {
    // Timestamps spread across the 30-day window (roughly monotonic ordering
    // by index so deep offsets are meaningful, with jitter).
    const base = ANCHOR_MS - SPAN_MS + Math.floor((i / TOTAL_ROWS) * SPAN_MS);
    const jitter = Math.floor(rng() * 60000); // up to 1 min jitter
    const ts = new Date(base + jitter).toISOString();
    const severity = pickSeverity(rng);
    const service = pick(rng, SERVICES);
    const message = buildMessage(rng);
    yield { ts, severity, service, message };
  }
}
