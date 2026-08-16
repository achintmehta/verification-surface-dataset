// Deterministic seed data definitions shared by the seeder.
// No randomness that isn't seeded: everything is derived from a row index so
// the corpus is identical on every boot / machine.

export const TOTAL_ROWS = 100000;

// 30-day span, ending "now-ish" but deterministic: we anchor to a fixed epoch
// so restarts produce identical timestamps.
export const ANCHOR_END_MS = Date.UTC(2024, 0, 31, 0, 0, 0); // 2024-01-31T00:00:00Z
export const SPAN_DAYS = 30;
export const SPAN_MS = SPAN_DAYS * 24 * 60 * 60 * 1000;

export const SERVICES = [
  'auth-service',
  'payment-gateway',
  'user-profile',
  'search-indexer',
  'notification-worker',
  'api-gateway',
  'billing-engine',
  'cache-proxy',
];

// Severity distribution ~60/25/10/5 (info/debug/warn/error).
// We map a per-row bucket (0..99) into a severity.
// info: 60, debug: 25, warn: 10, error: 5
export function severityForBucket(bucket) {
  if (bucket < 60) return 'info';
  if (bucket < 85) return 'debug';
  if (bucket < 95) return 'warn';
  return 'error';
}

// Message templates keyed loosely by severity so text is plausible.
// Templates use {frag} placeholders replaced with variable fragments,
// giving both selective (rare) and non-selective (common) substrings.
const TEMPLATES = {
  info: [
    'Request {method} {path} completed with status {status} in {ms}ms',
    'User {userId} session refreshed for tenant {tenant}',
    'Cache {cacheKey} hit ratio {ratio}% over window',
    'Processed batch {batchId} containing {count} records',
    'Healthcheck ok for node {node} region {region}',
  ],
  debug: [
    'Trace span {span} entered handler for {path}',
    'Config value {cfgKey} resolved to {cfgVal}',
    'Pool checkout latency {ms}ms for connection {conn}',
    'Serialized payload {batchId} size {count} bytes',
    'Retry attempt {attempt} scheduled for job {jobId}',
  ],
  warn: [
    'Slow query detected on {path} took {ms}ms threshold exceeded',
    'Deprecated endpoint {path} called by client {conn}',
    'Rate limit approaching for tenant {tenant} at {ratio}%',
    'Queue depth {count} for worker {node} nearing capacity',
    'Retrying upstream {region} after transient failure attempt {attempt}',
  ],
  error: [
    'Unhandled exception in {path} correlationId {span}',
    'Payment declined for user {userId} reason INSUFFICIENT_FUNDS',
    'Connection {conn} to database timed out after {ms}ms',
    'Failed to deliver notification job {jobId} to tenant {tenant}',
    'Cache {cacheKey} eviction storm detected dropping {count} keys',
  ],
};

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
const PATHS = ['/login', '/checkout', '/profile', '/search', '/notify', '/health', '/billing', '/assets'];
const STATUSES = [200, 201, 204, 400, 401, 404, 500, 503];
const REGIONS = ['us-east-1', 'us-west-2', 'eu-central-1', 'ap-south-1'];
const TENANTS = ['acme', 'globex', 'initech', 'umbrella', 'stark'];
const CFG_KEYS = ['maxConns', 'timeoutMs', 'featureFlag', 'shardCount'];

// Deterministic message builder for a given row index & severity.
export function buildMessage(i, severity) {
  const list = TEMPLATES[severity];
  const tmpl = list[i % list.length];
  const method = METHODS[i % METHODS.length];
  const path = PATHS[(i >> 1) % PATHS.length];
  const status = STATUSES[(i >> 2) % STATUSES.length];
  const ms = 5 + ((i * 37) % 1200);
  const userId = 10000 + ((i * 7) % 50000);
  const tenant = TENANTS[(i >> 3) % TENANTS.length];
  const cacheKey = 'ck-' + ((i * 13) % 9973); // prime-ish for spread
  const ratio = 40 + ((i * 3) % 60);
  const batchId = 'batch-' + ((i * 17) % 100000).toString(36);
  const count = (i * 11) % 5000;
  const node = 'node-' + (i % 24);
  const region = REGIONS[(i >> 4) % REGIONS.length];
  const span = 'span-' + ((i * 2654435761) >>> 0).toString(16).slice(0, 8);
  const cfgKey = CFG_KEYS[i % CFG_KEYS.length];
  const cfgVal = (i * 19) % 1000;
  const conn = 'conn-' + (i % 64);
  const attempt = 1 + (i % 5);
  const jobId = 'job-' + ((i * 31) % 100000);

  return tmpl
    .replace('{method}', method)
    .replace('{path}', path)
    .replace('{status}', status)
    .replace('{ms}', ms)
    .replace('{userId}', userId)
    .replace('{tenant}', tenant)
    .replace('{cacheKey}', cacheKey)
    .replace('{ratio}', ratio)
    .replace('{batchId}', batchId)
    .replace('{count}', count)
    .replace('{node}', node)
    .replace('{region}', region)
    .replace('{span}', span)
    .replace('{cfgKey}', cfgKey)
    .replace('{cfgVal}', cfgVal)
    .replace('{conn}', conn)
    .replace('{attempt}', attempt)
    .replace('{jobId}', jobId);
}

// Fast deterministic 32-bit integer hash (avalanche) for good spread.
export function hash32(x) {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

// Produce a single deterministic row for index i (0-based).
export function buildRow(i) {
  // Distribute timestamps evenly across the span, oldest at i=0.
  // Add a small deterministic jitter within the per-row slot so ties are rare
  // but ordering by ts remains stable & monotonic overall.
  const slot = Math.floor((i / TOTAL_ROWS) * SPAN_MS);
  const jitter = (i * 997) % 800; // < 1s jitter, keeps rows distinct-ish
  const tsMs = ANCHOR_END_MS - SPAN_MS + slot + jitter;
  const ts = new Date(tsMs).toISOString();

  const bucket = hash32(i) % 100; // scrambled bucket for severity spread
  const severity = severityForBucket(bucket);
  const service = SERVICES[hash32(i ^ 0x9e3779b9) % SERVICES.length];
  const message = buildMessage(i, severity);

  return { ts, severity, service, message };
}
