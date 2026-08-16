// Deterministic corpus generation.
//
// The corpus is 100,000 rows spanning a fixed 30-day window across 8 services.
// Severities are distributed roughly 60/25/10/5 (info/debug? -> see mapping below).
// Messages are drawn from templates with variable fragments, so that substring
// search has both selective (rare) and non-selective (common) terms.
//
// Everything here is a pure function of the row index `i`, which makes the seed
// fully reproducible: the same index always yields the same row.

import {
  TOTAL_ROWS,
  CORPUS_END_MS,
  CORPUS_SPAN_DAYS,
  SERVICES,
} from './config.js';

const SPAN_MS = CORPUS_SPAN_DAYS * 24 * 60 * 60 * 1000;
const CORPUS_START_MS = CORPUS_END_MS - SPAN_MS;

// A tiny, fast, deterministic PRNG (mulberry32). Seeded per-row so results are
// stable regardless of ordering or batching.
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

// Severity distribution: info 60%, debug 25%, warn 10%, error 5%.
// Bucketed by a deterministic value so the overall distribution is exact-ish.
function severityFor(r) {
  if (r < 0.6) return 'info';
  if (r < 0.85) return 'debug';
  if (r < 0.95) return 'warn';
  return 'error';
}

// Message templates keyed by severity. Fragments include:
//  - common tokens ("request", "user") -> non-selective substring search
//  - rare tokens ("quota", "deadlock") -> selective substring search
const TEMPLATES = {
  info: [
    'request completed for user {user} in {ms}ms',
    'processed batch {n} for service warmup',
    'user {user} session refreshed',
    'cache hit ratio {n}% on shard {shard}',
    'health check ok latency {ms}ms',
  ],
  debug: [
    'trace request {reqid} entering handler',
    'debug user {user} feature flag {flag} evaluated',
    'connection pool size {n} idle {shard}',
    'serialized payload {n} bytes for request',
    'retrying request {reqid} attempt {n}',
  ],
  warn: [
    'quota nearing limit for user {user} at {n}%',
    'slow request {reqid} took {ms}ms',
    'deprecated endpoint used by user {user}',
    'cache miss storm on shard {shard}',
    'backpressure detected queue depth {n}',
  ],
  error: [
    'deadlock detected while updating user {user}',
    'request {reqid} failed with timeout after {ms}ms',
    'quota exceeded hard limit for user {user}',
    'unhandled exception in service handler {reqid}',
    'connection reset on shard {shard} for request',
  ],
};

const FLAGS = ['alpha', 'beta', 'canary', 'gamma', 'legacy'];

/**
 * Build a single deterministic row for index `i` (0-based).
 * Timestamps are spread monotonically across the 30-day window so that ORDER BY
 * ts corresponds cleanly to row generation (index 0 = oldest).
 */
export function makeRow(i) {
  const rnd = mulberry32(i * 2654435761 + 1013904223);

  // Even spread across the window, plus small deterministic jitter, kept within
  // the window bounds. Distinct-ish timestamps; ties broken by id in the query.
  const base = CORPUS_START_MS + Math.floor((i / TOTAL_ROWS) * SPAN_MS);
  const jitter = Math.floor(rnd() * 1000); // sub-second jitter
  const tsMs = Math.min(base + jitter, CORPUS_END_MS - 1);
  const ts = new Date(tsMs).toISOString();

  const severity = severityFor(rnd());
  const service = SERVICES[Math.floor(rnd() * SERVICES.length)];

  const templates = TEMPLATES[severity];
  const template = templates[Math.floor(rnd() * templates.length)];

  const message = template
    .replace('{user}', `u${1000 + Math.floor(rnd() * 5000)}`)
    .replace('{ms}', String(1 + Math.floor(rnd() * 800)))
    .replace('{n}', String(Math.floor(rnd() * 1024)))
    .replace('{shard}', String(Math.floor(rnd() * 16)))
    .replace('{reqid}', `r${Math.floor(rnd() * 1_000_000).toString(16)}`)
    .replace('{flag}', FLAGS[Math.floor(rnd() * FLAGS.length)]);

  return { id: i + 1, ts, severity, service, message };
}

/**
 * Yields batches of rows for seeding. Each batch is an array of row objects.
 */
export function* rowBatches(batchSize) {
  let batch = [];
  for (let i = 0; i < TOTAL_ROWS; i++) {
    batch.push(makeRow(i));
    if (batch.length >= batchSize) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}
