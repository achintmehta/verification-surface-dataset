// Deterministic corpus generation.
//
// Given a row index in [0, SEED_ROW_COUNT), this module produces the exact same
// log row on every boot. The randomness is driven by a seeded PRNG so the
// corpus is reproducible: no wall-clock time, no Math.random.

import {
  SEED_ROW_COUNT,
  SEVERITIES,
  SERVICES,
  CORPUS_DAYS,
  CORPUS_END_MS,
} from './config.js';

// mulberry32: a tiny, fast, deterministic PRNG. Seeded from an integer.
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

// Severity distribution roughly 60/25/10/5 (debug/info/warn/error).
// We express it as cumulative thresholds over a [0,1) draw.
// NOTE: per spec, severities are distributed 60/25/10/5. We map:
//   info 60%, debug 25%, warn 10%, error 5%
// (info is the dominant severity in a real service).
const SEVERITY_CUMULATIVE = [
  { severity: 'info', threshold: 0.6 },
  { severity: 'debug', threshold: 0.85 },
  { severity: 'warn', threshold: 0.95 },
  { severity: 'error', threshold: 1.0 },
];

function pickSeverity(r) {
  for (const entry of SEVERITY_CUMULATIVE) {
    if (r < entry.threshold) return entry.severity;
  }
  return 'error';
}

// Message templates keyed by severity. Each template has {slots} that get
// filled from fragment pools. Some fragments are rare (selective substrings)
// and some are common (non-selective substrings), giving search meaningful
// selectivity variation.
const TEMPLATES = {
  info: [
    'request completed for {resource} in {ms}ms',
    'user {user} logged in from {region}',
    'cache hit for key {resource}',
    'processed batch job {job} successfully',
    'health check passed for {region}',
  ],
  debug: [
    'entering handler {handler} with payload size {ms}',
    'db query {job} took {ms}ms',
    'trace span opened for {resource}',
    'config value {handler} resolved to {region}',
    'retry attempt {ms} scheduled for {job}',
  ],
  warn: [
    'slow response {ms}ms for {resource}',
    'deprecated endpoint {handler} used by {user}',
    'rate limit approaching for {user} in {region}',
    'cache miss cascade detected for {resource}',
    'connection pool nearly exhausted on {region}',
  ],
  error: [
    'unhandled exception in {handler}: {resource} not found',
    'payment declined for {user} transaction {job}',
    'database connection timeout after {ms}ms',
    'failed to publish event {job} to {region}',
    'authentication failure for {user} from {region}',
  ],
};

// Fragment pools. Some pools contain a rare "needle" value so that a substring
// search for it is highly selective, alongside common values.
const RESOURCES = [
  '/api/orders',
  '/api/users',
  '/api/products',
  '/api/checkout',
  '/api/search',
  '/api/rare-canary-endpoint', // selective needle
];
const REGIONS = ['us-east-1', 'us-west-2', 'eu-central-1', 'ap-south-1'];
const HANDLERS = ['OrderHandler', 'AuthHandler', 'SearchHandler', 'BillingHandler'];

function pad(n, width) {
  return String(n).padStart(width, '0');
}

function fillTemplate(template, rng) {
  return template.replace(/\{(\w+)\}/g, (_, slot) => {
    switch (slot) {
      case 'resource':
        return RESOURCES[Math.floor(rng() * RESOURCES.length)];
      case 'region':
        return REGIONS[Math.floor(rng() * REGIONS.length)];
      case 'handler':
        return HANDLERS[Math.floor(rng() * HANDLERS.length)];
      case 'user':
        return 'user_' + pad(Math.floor(rng() * 5000), 4);
      case 'job':
        return 'job_' + pad(Math.floor(rng() * 100000), 5);
      case 'ms':
        return String(1 + Math.floor(rng() * 5000));
      default:
        return slot;
    }
  });
}

// The corpus is ordered by index; we deliberately assign timestamps that are
// monotonically DECREASING as index increases so that index 0 is the newest.
// This keeps the natural row ordering (ts DESC) aligned with index, which is
// convenient but the DB still sorts explicitly.
//
// Timestamps are spread evenly across CORPUS_DAYS, with a small deterministic
// jitter so multiple rows can share the same second-ish window realistically.
const SPAN_MS = CORPUS_DAYS * 24 * 60 * 60 * 1000;

/**
 * Generate a single deterministic log row for the given index.
 * @param {number} index 0-based index in [0, SEED_ROW_COUNT)
 * @returns {{ts: Date, severity: string, service: string, message: string}}
 */
export function generateRow(index) {
  // Seed the PRNG from the index so each row is independent and reproducible.
  const rng = mulberry32((index + 1) * 2654435761);

  const severity = pickSeverity(rng());
  const service = SERVICES[Math.floor(rng() * SERVICES.length)];

  const templates = TEMPLATES[severity];
  const template = templates[Math.floor(rng() * templates.length)];
  const message = fillTemplate(template, rng);

  // Even spread across the span; newest at index 0.
  const base = CORPUS_END_MS - Math.floor((index / SEED_ROW_COUNT) * SPAN_MS);
  const jitter = Math.floor(rng() * 1000); // sub-second jitter
  const tsMs = base - jitter;

  return {
    ts: new Date(tsMs),
    severity,
    service,
    message,
  };
}

/**
 * Iterate the entire corpus in batches.
 * @param {number} batchSize
 * @param {(rows: Array, startIndex: number) => Promise<void>} onBatch
 */
export async function forEachBatch(batchSize, onBatch) {
  let start = 0;
  while (start < SEED_ROW_COUNT) {
    const end = Math.min(start + batchSize, SEED_ROW_COUNT);
    const rows = [];
    for (let i = start; i < end; i++) {
      rows.push(generateRow(i));
    }
    await onBatch(rows, start);
    start = end;
  }
}
