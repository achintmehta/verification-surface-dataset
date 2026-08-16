import { getDb, ensureSchema, ensureIndexes, tryEnableTrigram, seededCount, SEVERITIES, TOTAL_ROWS } from './db.js';

const SERVICES = [
  'auth-service',
  'payment-gateway',
  'user-api',
  'search-indexer',
  'notification-worker',
  'billing-cron',
  'edge-proxy',
  'analytics-pipeline',
];

// Severity distribution ~ 60/25/10/5 (info/debug? spec: severities distributed
// roughly 60/25/10/5). Map to info=60, debug=25, warn=10, error=5.
// Ordered list weighted; we pick by deterministic hash bucket.
const SEVERITY_BUCKETS = (() => {
  const buckets = [];
  const spec = [
    ['info', 60],
    ['debug', 25],
    ['warn', 10],
    ['error', 5],
  ];
  for (const [sev, n] of spec) {
    for (let i = 0; i < n; i++) buckets.push(sev);
  }
  return buckets; // length 100
})();

// Message templates. {frag} is replaced with a fragment. We mix selective terms
// (rare fragments) and non-selective terms (common words in every template).
const TEMPLATES = [
  'request completed for endpoint {frag} in {ms}ms',
  'connection established to {frag} pool',
  'cache miss for key user:{frag}',
  'retry attempt {n} for operation {frag}',
  'user {frag} authenticated successfully',
  'payment {frag} processed via card ending 4242',
  'slow query detected on table {frag}',
  'background job {frag} enqueued',
  'rate limit exceeded for client {frag}',
  'health check {frag} responded ok',
];

// Fragments: some rare (selective), some common (non-selective).
const FRAGMENTS = [
  'orders', 'sessions', 'invoices', 'tokens', 'profiles',
  'checkout', 'webhook', 'nightly-reconcile', 'gzip-batch', 'quantum-shard',
];

// A rare fragment inserted occasionally so a very selective search term exists.
const RARE_FRAGMENT = 'zeta-anomaly-7734';

const SERVICE_COUNT = SERVICES.length;
const FRAG_COUNT = FRAGMENTS.length;
const TEMPLATE_COUNT = TEMPLATES.length;

// 30 day span in ms.
const SPAN_MS = 30 * 24 * 60 * 60 * 1000;
const BASE_TS = Date.parse('2024-01-01T00:00:00.000Z');

function buildRow(i) {
  const severity = SEVERITY_BUCKETS[i % 100];
  const service = SERVICES[i % SERVICE_COUNT];
  const template = TEMPLATES[i % TEMPLATE_COUNT];
  const frag = FRAGMENTS[(i * 7) % FRAG_COUNT];
  const ms = (i * 13) % 950 + 1;
  const n = (i % 5) + 1;

  let message = template
    .replace('{frag}', frag)
    .replace('{ms}', String(ms))
    .replace('{n}', String(n));

  // Sprinkle the rare fragment ~ every 2000 rows (~50 occurrences total).
  if (i % 2000 === 0) {
    message += ` ${RARE_FRAGMENT}`;
  }

  // Deterministic timestamps evenly spread across the 30-day span so that
  // ts DESC ordering is well-defined and stable.
  const ts = new Date(BASE_TS + Math.floor((i * SPAN_MS) / TOTAL_ROWS)).toISOString();

  return { id: i, ts, severity, service, message };
}

/**
 * Seed exactly TOTAL_ROWS rows in batches, only if the table is empty.
 * Returns { seeded: boolean, rows: number, ms: number }.
 */
export async function seedIfNeeded() {
  const start = Date.now();
  await ensureSchema();

  const existing = await seededCount();
  if (existing >= TOTAL_ROWS) {
    // Already seeded — make sure indexes exist, then skip.
    const trigram = await tryEnableTrigram();
    await ensureIndexes({ trigram });
    return { seeded: false, rows: existing, ms: Date.now() - start };
  }

  // Fresh (or partial) — start clean for determinism.
  const d = await getDb();
  if (existing > 0) {
    await d.exec('TRUNCATE logs');
  }

  const BATCH = 1000;
  for (let start0 = 0; start0 < TOTAL_ROWS; start0 += BATCH) {
    const end = Math.min(start0 + BATCH, TOTAL_ROWS);
    const values = [];
    const params = [];
    let p = 1;
    for (let i = start0; i < end; i++) {
      const r = buildRow(i);
      values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(r.id, r.ts, r.severity, r.service, r.message);
    }
    await d.query(
      `INSERT INTO logs (id, ts, severity, service, message) VALUES ${values.join(',')}`,
      params
    );
  }

  // Build indexes after the bulk load.
  const trigram = await tryEnableTrigram();
  await ensureIndexes({ trigram });

  const rows = await seededCount();
  return { seeded: true, rows, ms: Date.now() - start };
}

export { SERVICES, SEVERITIES };
