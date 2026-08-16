// Deterministic seed generator for the log corpus.
//
// Produces exactly TOTAL_ROWS rows spanning SPAN_DAYS days across SERVICES
// services, with severities distributed roughly 60/25/10/5 (info/warn/... no:
// per the spec the distribution is debug/info/warn/error skewed toward the
// less severe. We use 60% info, 25% debug, 10% warn, 5% error which keeps the
// same 60/25/10/5 shape while ensuring all four severities appear.)
//
// Messages are drawn from templates with variable fragments so substring
// search has both selective (rare tokens) and non-selective (common tokens)
// terms.

export const TOTAL_ROWS = 100000;
export const SPAN_DAYS = 30;
export const BATCH_SIZE = 2000;

export const SERVICES = [
  'auth-service',
  'billing-service',
  'gateway',
  'inventory-service',
  'notification-service',
  'payments-service',
  'search-service',
  'user-service',
];

// Severity distribution weights (roughly 60/25/10/5).
// Ordered so the cumulative thresholds are easy to reason about.
const SEVERITY_TABLE = [
  { severity: 'info', weight: 60 },
  { severity: 'debug', weight: 25 },
  { severity: 'warn', weight: 10 },
  { severity: 'error', weight: 5 },
];

// Message templates. `{n}` is replaced with a numeric fragment, `{tok}` with
// a token drawn from FRAGMENTS. Some templates carry rare tokens (selective)
// and others carry very common words (non-selective).
const TEMPLATES = [
  'Request completed in {n}ms for endpoint {tok}',
  'User {n} authenticated successfully via {tok}',
  'Cache miss for key {tok}:{n}',
  'Database query took {n}ms on table {tok}',
  'Connection to {tok} established after {n} retries',
  'Payment {n} processed with status {tok}',
  'Rate limit reached for client {tok} ({n} requests)',
  'Background job {tok} finished processing {n} items',
  'Health check {tok} returned status {n}',
  'Deprecation warning: {tok} will be removed in {n} days',
  'Timeout while contacting {tok} after {n}ms',
  'Unhandled exception in {tok} at line {n}',
  'Configuration reloaded: {tok} set to {n}',
  'Session {n} expired for user {tok}',
  'Metric flush emitted {n} points to {tok}',
];

// Fragment tokens. Some are common (appear in many rows), some are rare.
const FRAGMENTS = [
  // common tokens
  'success', 'success', 'success', 'default', 'default', 'primary', 'primary',
  'user', 'user', 'session', 'session', 'queue', 'queue', 'worker', 'worker',
  // moderately common
  'redis', 'postgres', 'kafka', 'oauth', 'jwt', 'stripe', 'webhook',
  // rare / selective tokens (appear only occasionally)
  'quantum-flux', 'nebula-token', 'zephyr-cache', 'obsidian-node',
];

// A tiny deterministic PRNG (mulberry32) so the corpus is identical every seed.
function makeRng(seed) {
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
  // r in [0,1)
  const total = SEVERITY_TABLE.reduce((s, e) => s + e.weight, 0);
  let x = r * total;
  for (const entry of SEVERITY_TABLE) {
    if (x < entry.weight) return entry.severity;
    x -= entry.weight;
  }
  return SEVERITY_TABLE[SEVERITY_TABLE.length - 1].severity;
}

function buildMessage(rng) {
  const template = TEMPLATES[Math.floor(rng() * TEMPLATES.length)];
  const tok = FRAGMENTS[Math.floor(rng() * FRAGMENTS.length)];
  const n = Math.floor(rng() * 10000);
  return template.replace('{tok}', tok).replace('{n}', String(n));
}

/**
 * Generate the full corpus as an array of row objects.
 * Rows are ordered so that ts is monotonically increasing with index; the
 * oldest row is index 0, the newest is the last. `ts` spans SPAN_DAYS ending
 * at a fixed anchor timestamp so the corpus is fully deterministic.
 */
export function* generateBatches(batchSize = BATCH_SIZE) {
  const rng = makeRng(1337);
  // Fixed anchor: 2024-01-31T00:00:00Z. Corpus spans the 30 days before it.
  const anchorMs = Date.UTC(2024, 0, 31, 0, 0, 0);
  const spanMs = SPAN_DAYS * 24 * 60 * 60 * 1000;
  const stepMs = spanMs / TOTAL_ROWS;

  let batch = [];
  for (let i = 0; i < TOTAL_ROWS; i++) {
    // Deterministic timestamp: evenly stepped + small deterministic jitter.
    const jitter = Math.floor((rng() - 0.5) * stepMs);
    let tsMs = anchorMs - spanMs + Math.floor(i * stepMs) + jitter;
    const ts = new Date(tsMs).toISOString();
    const severity = pickSeverity(rng());
    const service = SERVICES[Math.floor(rng() * SERVICES.length)];
    const message = buildMessage(rng);
    batch.push({ ts, severity, service, message });
    if (batch.length === batchSize) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}
