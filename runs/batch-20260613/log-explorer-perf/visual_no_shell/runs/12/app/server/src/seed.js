// Deterministic seed generator for the log corpus.
//
// Requirements:
//  - exactly N rows (100,000)
//  - spanning 30 days
//  - across 8 services
//  - severities distributed roughly 60/25/10/5 (info/debug/warn/error)
//  - messages drawn from templates with variable fragments so substring
//    search has both selective and non-selective terms.
//
// Everything is derived from the row index i, so the corpus is fully
// deterministic and reproducible across boots.

const SERVICES = [
  'auth-service',
  'payment-gateway',
  'order-processor',
  'inventory-service',
  'notification-worker',
  'api-gateway',
  'search-indexer',
  'user-profile',
];

// Severity buckets by weight. Distribution ~ 60/25/10/5.
// info 60, debug 25, warn 10, error 5.
const SEVERITY_TABLE = [];
for (let k = 0; k < 60; k++) SEVERITY_TABLE.push('info');
for (let k = 0; k < 25; k++) SEVERITY_TABLE.push('debug');
for (let k = 0; k < 10; k++) SEVERITY_TABLE.push('warn');
for (let k = 0; k < 5; k++) SEVERITY_TABLE.push('error');

// Message templates keyed by severity. {n}, {id}, {ms}, {code} are variable
// fragments. Some tokens (like "GET", "user") are non-selective (appear a lot);
// others (like "deadlock", "OOM") are selective (rare).
const TEMPLATES = {
  info: [
    'GET /api/v1/resource/{id} completed in {ms}ms',
    'user {id} logged in successfully',
    'cache hit for key session:{id}',
    'processed batch job #{n} with {n} items',
    'health check OK, uptime {n}s',
  ],
  debug: [
    'entering handler for request {id}',
    'query executed in {ms}ms, returned {n} rows',
    'serialized payload of {n} bytes for user {id}',
    'connection pool size now {n}',
    'feature flag experimental_search evaluated to true for {id}',
  ],
  warn: [
    'slow query detected: {ms}ms for request {id}',
    'retrying upstream call, attempt {n}',
    'deprecated endpoint accessed by client {id}',
    'rate limit approaching for tenant {id} ({n}%)',
    'cache miss storm detected on key prefix search:',
  ],
  error: [
    'deadlock detected while committing transaction {id}',
    'OOM: worker {id} killed after {ms}ms',
    'payment declined for order {id} with code {code}',
    'unhandled exception in handler {id}: null pointer',
    'connection refused to upstream after {ms}ms',
  ],
};

const CODES = ['E101', 'E404', 'E500', 'E502', 'E900'];

// Simple deterministic PRNG (mulberry32) seeded per-row for reproducibility.
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildMessage(severity, i) {
  const rnd = mulberry32(i * 2654435761);
  const templates = TEMPLATES[severity];
  const tpl = templates[Math.floor(rnd() * templates.length)];
  const id = Math.floor(rnd() * 100000);
  const n = Math.floor(rnd() * 5000);
  const ms = Math.floor(rnd() * 3000);
  const code = CODES[Math.floor(rnd() * CODES.length)];
  return tpl
    .replaceAll('{id}', String(id))
    .replaceAll('{n}', String(n))
    .replaceAll('{ms}', String(ms))
    .replaceAll('{code}', code);
}

export function generateRow(i, baseMs, spanMs, total) {
  // Distribute timestamps evenly across the 30-day span. Row 0 = oldest,
  // last row = newest. A little deterministic jitter keeps ties minimal.
  const rnd = mulberry32(i * 40503 + 7);
  const jitter = Math.floor(rnd() * (spanMs / total)); // < one slot
  const ts = new Date(baseMs + Math.floor((i / total) * spanMs) + jitter);

  const severity = SEVERITY_TABLE[i % SEVERITY_TABLE.length];
  const service = SERVICES[i % SERVICES.length];
  const message = buildMessage(severity, i);

  return {
    id: i + 1,
    ts: ts.toISOString(),
    severity,
    service,
    message,
  };
}

export async function seedCorpus(db, total) {
  const now = Date.now();
  const spanMs = 30 * 24 * 60 * 60 * 1000; // 30 days
  const baseMs = now - spanMs;

  const BATCH = 2000;
  const COLS = 5;

  for (let start = 0; start < total; start += BATCH) {
    const end = Math.min(start + BATCH, total);
    const values = [];
    const params = [];
    let p = 1;
    for (let i = start; i < end; i++) {
      const row = generateRow(i, baseMs, spanMs, total);
      values.push(`($${p++},$${p++},$${p++},$${p++},$${p++})`);
      params.push(row.id, row.ts, row.severity, row.service, row.message);
    }
    const sql = `INSERT INTO logs (id, ts, severity, service, message) VALUES ${values.join(',')};`;
    await db.query(sql, params);
  }
}

export { SERVICES };
