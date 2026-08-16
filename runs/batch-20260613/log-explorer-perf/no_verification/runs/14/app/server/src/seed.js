// Deterministic seed of exactly 100,000 log entries.
// - Spans 30 days, evenly distributed in time.
// - 8 services.
// - Severities distributed roughly 60/25/10/5 (info/debug/warn/error... see below).
// - Messages built from templates with variable fragments so that some substrings
//   are highly selective and others are non-selective.

export const TOTAL_ROWS = 100_000;
const DAYS_SPAN = 30;
const BATCH_SIZE = 2000;

const SERVICES = [
  'auth-service',
  'payment-gateway',
  'user-api',
  'search-index',
  'notification-worker',
  'billing-cron',
  'media-transcoder',
  'edge-proxy',
];

// Severity distribution ~ 60/25/10/5.
// info 60%, debug 25%, warn 10%, error 5%.
function pickSeverity(r) {
  if (r < 0.60) return 'info';
  if (r < 0.85) return 'debug';
  if (r < 0.95) return 'warn';
  return 'error';
}

// Message templates with {token} placeholders.
// Some fragments (e.g. "timeout", specific ids) are selective; others (e.g. "request") are non-selective.
const TEMPLATES = {
  info: [
    'handled request GET /v1/users/{uid} in {ms}ms',
    'request completed with status 200 for /v1/orders/{oid}',
    'cache hit for key session:{uid}',
    'processed message batch of {n} items',
    'user {uid} logged in from region {region}',
  ],
  debug: [
    'trace span started for operation op-{oid}',
    'evaluating feature flag flag-{n} for user {uid}',
    'connection pool stats: active={n} idle={ms}',
    'serialized payload of {n} bytes for request {oid}',
    'debug checkpoint reached in module mod-{region}',
  ],
  warn: [
    'slow query detected: {ms}ms on table shard-{n}',
    'retry attempt {n} for downstream call to {region}',
    'deprecated endpoint used by client cli-{uid}',
    'high memory usage {n}% on host node-{region}',
  ],
  error: [
    'request timeout after {ms}ms calling {region} service',
    'unhandled exception in handler for /v1/orders/{oid}',
    'failed to acquire lock lock-{n} for resource res-{uid}',
    'connection refused to database shard-{n}',
  ],
};

const REGIONS = ['us-east', 'us-west', 'eu-central', 'ap-south', 'sa-east'];

// Small deterministic PRNG (mulberry32) so the corpus is identical on every seed.
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

function buildMessage(rng, severity) {
  const list = TEMPLATES[severity];
  const tmpl = list[Math.floor(rng() * list.length)];
  return tmpl.replace(/\{(\w+)\}/g, (_, token) => {
    switch (token) {
      case 'uid':
        return String(1000 + Math.floor(rng() * 9000));
      case 'oid':
        return String(500000 + Math.floor(rng() * 500000));
      case 'ms':
        return String(1 + Math.floor(rng() * 5000));
      case 'n':
        return String(1 + Math.floor(rng() * 512));
      case 'region':
        return REGIONS[Math.floor(rng() * REGIONS.length)];
      default:
        return token;
    }
  });
}

/**
 * Seeds the corpus deterministically in batches using multi-row INSERT statements.
 */
export async function seedCorpus(db) {
  const rng = mulberry32(0x1234abcd);

  const startMs = Date.parse('2024-01-01T00:00:00Z');
  const endMs = startMs + DAYS_SPAN * 24 * 60 * 60 * 1000;
  const stepMs = (endMs - startMs) / TOTAL_ROWS;

  await db.exec('BEGIN;');
  try {
    for (let batchStart = 0; batchStart < TOTAL_ROWS; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL_ROWS);
      const values = [];
      const params = [];
      let p = 0;

      for (let i = batchStart; i < batchEnd; i++) {
        const severity = pickSeverity(rng());
        const service = SERVICES[Math.floor(rng() * SERVICES.length)];
        const message = buildMessage(rng, severity);
        // ts increases with i (ascending in time); ordering DESC gives newest first.
        const ts = new Date(Math.floor(startMs + i * stepMs)).toISOString();

        values.push(`($${++p},$${++p},$${++p},$${++p},$${++p})`);
        params.push(i + 1, ts, severity, service, message);
      }

      await db.query(
        `INSERT INTO logs (id, ts, severity, service, message) VALUES ${values.join(',')};`,
        params
      );
    }
    await db.exec('COMMIT;');
  } catch (err) {
    await db.exec('ROLLBACK;');
    throw err;
  }
}
