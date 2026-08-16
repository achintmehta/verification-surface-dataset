// Deterministic corpus generation.
//
// Every field of every row is a pure function of the row's index, so the seed
// is fully reproducible: the same 100,000 rows are produced on every fresh
// boot, regardless of platform or timing. This determinism is what makes the
// acceptance criteria ("the row at offset K equals what the UI shows") stable.

import { config } from './config.js';

const { services, severityDistribution, days, totalRows } = config.seed;

// A tiny deterministic PRNG (mulberry32) seeded from the row index. We avoid
// Math.random so the corpus is identical across runs.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Message templates. Some fragments are highly selective (rare) so substring
// search has both selective and non-selective terms, as required.
const TEMPLATES = [
  'Request completed in {ms}ms for {path}',
  'User {uid} authenticated successfully',
  'Cache miss for key {key}',
  'Database query took {ms}ms',
  'Connection pool exhausted, waiting for {ms}ms',
  'Payment {uid} processed for amount {amt}',
  'Rate limit exceeded for client {uid}',
  'Retrying operation {op} attempt {n}',
  'Background job {op} finished with status {status}',
  'Deprecated endpoint {path} accessed by {uid}',
  'Health check passed for node {n}',
  'Configuration reloaded from {path}',
];

const PATHS = ['/api/v1/users', '/api/v1/orders', '/healthz', '/api/v2/search', '/api/v1/checkout'];
const OPS = ['reindex', 'flush', 'compact', 'snapshot', 'rollup'];
const STATUSES = ['ok', 'failed', 'skipped'];

function pickSeverity(bucket) {
  for (const entry of severityDistribution) {
    if (bucket < entry.threshold) return entry.level;
  }
  return severityDistribution[severityDistribution.length - 1].level;
}

function buildMessage(rng, i) {
  const template = TEMPLATES[i % TEMPLATES.length];
  return template
    .replace('{ms}', String(1 + Math.floor(rng() * 5000)))
    .replace('{uid}', 'u' + (1000 + Math.floor(rng() * 9000)))
    .replace('{key}', 'sess:' + (100000 + Math.floor(rng() * 900000)).toString(16))
    .replace('{amt}', '$' + (Math.floor(rng() * 100000) / 100).toFixed(2))
    .replace('{op}', OPS[Math.floor(rng() * OPS.length)])
    .replace('{n}', String(Math.floor(rng() * 32)))
    .replace('{status}', STATUSES[Math.floor(rng() * STATUSES.length)])
    .replace('{path}', PATHS[Math.floor(rng() * PATHS.length)]);
}

// Timestamp range: rows evenly spread across `days`, ending "now" relative to a
// fixed epoch anchor so timestamps are deterministic too.
const EPOCH_ANCHOR = Date.UTC(2024, 0, 1, 0, 0, 0); // 2024-01-01T00:00:00Z
const SPAN_MS = days * 24 * 60 * 60 * 1000;

/**
 * Generate a single deterministic row for index i (0-based).
 * @returns {{ts: string, severity: string, service: string, message: string}}
 */
export function generateRow(i) {
  const rng = mulberry32(i + 1);
  // Evenly distribute timestamps; add a deterministic jitter so ties are rare
  // but ordering by ts remains stable and reproducible.
  const base = EPOCH_ANCHOR + Math.floor((SPAN_MS * i) / totalRows);
  const jitter = Math.floor(rng() * 1000);
  const ts = new Date(base + jitter).toISOString();

  const severity = pickSeverity(Math.floor(rng() * 100));
  const service = services[Math.floor(rng() * services.length)];
  const message = buildMessage(rng, i);

  return { ts, severity, service, message };
}

/**
 * Yield rows in batches of `batchSize` for streaming inserts.
 * @param {number} batchSize
 */
export function* generateBatches(batchSize) {
  let batch = [];
  for (let i = 0; i < totalRows; i++) {
    batch.push(generateRow(i));
    if (batch.length >= batchSize) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}
