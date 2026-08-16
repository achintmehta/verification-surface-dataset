// Deterministic seed generator for the log corpus.
//
// Produces exactly TOTAL_ROWS rows spanning 30 days across 8 services, with
// severities distributed roughly 60/25/10/5 (info/warn/error... actually
// debug/info/warn/error per the schema). Messages are drawn from templates
// with variable fragments so that substring search has both selective terms
// (rare fragments) and non-selective terms (common words).
//
// Determinism: a tiny seeded PRNG (mulberry32) drives every choice, so the
// same corpus is produced on every fresh boot.

export const TOTAL_ROWS = 100000;
const DAYS_SPAN = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Fixed epoch anchor so timestamps are deterministic and independent of when
// the seed actually runs. 2024-01-01T00:00:00.000Z.
const EPOCH_START = Date.UTC(2024, 0, 1, 0, 0, 0, 0);
const WINDOW_MS = DAYS_SPAN * MS_PER_DAY;

export const SERVICES = [
  'auth-service',
  'payment-gateway',
  'user-profile',
  'search-indexer',
  'notification-worker',
  'api-gateway',
  'inventory-service',
  'recommendation-engine',
];

// Severities and their approximate cumulative distribution.
// debug 60%, info 25%, warn 10%, error 5%.
export const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_CUMULATIVE = [
  { sev: 'debug', p: 0.6 },
  { sev: 'info', p: 0.85 },
  { sev: 'warn', p: 0.95 },
  { sev: 'error', p: 1.0 },
];

// Message templates keyed loosely by severity flavour. {n}, {id}, {ms}, {code}
// and {region} are variable fragments. Some fragments (e.g. request ids) are
// highly selective; common words like "request" / "user" are non-selective.
const TEMPLATES = {
  debug: [
    'Handling incoming request for endpoint /v1/resource/{n}',
    'Cache lookup for key session:{id} completed in {ms}ms',
    'Serialized payload of {n} bytes for downstream call',
    'Trace span opened for operation batch-{id}',
    'Evaluating feature flag rollout-{n} for user {id}',
    'Connection pool checkout took {ms}ms slot={n}',
  ],
  info: [
    'Request completed with status {code} in {ms}ms',
    'User {id} authenticated successfully from region {region}',
    'Processed {n} records in scheduled job run-{id}',
    'Published event order-created:{id} to topic events',
    'Health check passed for node {n} region {region}',
    'Configuration reloaded revision {n}',
  ],
  warn: [
    'Slow query detected duration={ms}ms query-id={id}',
    'Retry attempt {n} for request {id} region {region}',
    'Rate limit approaching for tenant {id} at {n} percent',
    'Deprecated endpoint /v0/resource/{n} called by client {id}',
    'Cache miss ratio elevated to {n} percent on shard {n}',
  ],
  error: [
    'Unhandled exception in handler request-{id} code {code}',
    'Failed to connect to upstream dependency after {n} retries',
    'Transaction rollback for order {id} reason timeout {ms}ms',
    'Payment declined for user {id} error-code E{code}',
    'Timeout waiting for lock resource-{n} after {ms}ms',
  ],
};

const REGIONS = ['us-east-1', 'us-west-2', 'eu-central-1', 'ap-south-1', 'sa-east-1'];

// mulberry32 seeded PRNG.
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

function pickSeverity(r) {
  for (const { sev, p } of SEVERITY_CUMULATIVE) {
    if (r < p) return sev;
  }
  return 'error';
}

function fillTemplate(template, rnd) {
  return template
    .replace(/\{n\}/g, () => String(Math.floor(rnd() * 10000)))
    .replace(/\{id\}/g, () => Math.floor(rnd() * 0xffffffff).toString(16).padStart(8, '0'))
    .replace(/\{ms\}/g, () => String(Math.floor(rnd() * 5000) + 1))
    .replace(/\{code\}/g, () => String([200, 201, 400, 404, 500, 503][Math.floor(rnd() * 6)]))
    .replace(/\{region\}/g, () => REGIONS[Math.floor(rnd() * REGIONS.length)]);
}

/**
 * Generate the full corpus as an array of row objects.
 * Rows are produced in a deterministic order. Timestamps are spread across the
 * 30-day window; they are NOT necessarily monotonic (the API orders by ts).
 *
 * @returns {Array<{ts:string, severity:string, service:string, message:string}>}
 */
export function generateCorpus() {
  const rnd = mulberry32(0x1234abcd);
  const rows = new Array(TOTAL_ROWS);
  for (let i = 0; i < TOTAL_ROWS; i++) {
    const severity = pickSeverity(rnd());
    const service = SERVICES[Math.floor(rnd() * SERVICES.length)];
    const templates = TEMPLATES[severity];
    const template = templates[Math.floor(rnd() * templates.length)];
    const message = fillTemplate(template, rnd);
    // Timestamp deterministically spread across the window.
    const offsetMs = Math.floor(rnd() * WINDOW_MS);
    const ts = new Date(EPOCH_START + offsetMs).toISOString();
    rows[i] = { ts, severity, service, message };
  }
  return rows;
}
