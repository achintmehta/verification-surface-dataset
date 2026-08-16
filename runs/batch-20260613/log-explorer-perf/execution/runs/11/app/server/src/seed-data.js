import {
  SERVICES,
  SEVERITY_WEIGHTS,
  CORPUS_DAYS,
  TOTAL_ROWS,
} from './config.js';

// -----------------------------------------------------------------------------
// Deterministic pseudo-random generator (mulberry32). Given the same seed, the
// exact same corpus is produced on every boot, on every machine. No Math.random.
// -----------------------------------------------------------------------------
export function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Message templates. `{frag}` is replaced with a fragment picked from the
// matching pool below. The pools are deliberately structured so that some
// substrings are highly selective (rare) and others are non-selective (common),
// which is needed to grade selective vs non-selective substring search.
const TEMPLATES = [
  'request {frag} completed with status {status}',
  'user {frag} authenticated from {ip}',
  'cache {frag} for key {key}',
  'db query {frag} took {ms}ms',
  'payment {frag} for order {order}',
  'connection {frag} to upstream {ip}',
  'job {frag} scheduled at {ms}ms interval',
  'retry {frag} attempt for {key}',
];

// Common fragments appear frequently across rows -> non-selective search terms.
const COMMON_FRAGMENTS = [
  'handler',
  'session',
  'lookup',
  'batch',
  'transaction',
];

// Rare fragments appear infrequently -> selective search terms. The word
// "quasar" in particular is engineered to be a needle in the haystack.
const RARE_FRAGMENTS = [
  'quasar',
  'nebula',
  'zephyr',
  'obelisk',
];

const STATUSES = [200, 201, 204, 301, 400, 404, 500, 503];

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

function severityForBucket(bucket) {
  for (const { severity, threshold } of SEVERITY_WEIGHTS) {
    if (bucket < threshold) return severity;
  }
  return SEVERITY_WEIGHTS[SEVERITY_WEIGHTS.length - 1].severity;
}

const CORPUS_MS = CORPUS_DAYS * 24 * 60 * 60 * 1000;
// Anchor the corpus at a fixed instant so timestamps are fully deterministic.
const CORPUS_END = Date.UTC(2024, 0, 31, 0, 0, 0); // 2024-01-31T00:00:00Z
const CORPUS_START = CORPUS_END - CORPUS_MS;

/**
 * Build a single log row deterministically from its index.
 * Timestamps are strictly monotonic in index order so that ordering by ts
 * descending is stable and the row at any offset is well-defined.
 */
export function buildRow(i) {
  const rng = makeRng(i * 2654435761 + 1);

  // Evenly spread timestamps across the 30-day window in index order, with a
  // small deterministic jitter that never breaks monotonicity.
  const base = CORPUS_START + Math.floor((i / TOTAL_ROWS) * CORPUS_MS);
  const jitter = Math.floor(rng() * Math.floor(CORPUS_MS / TOTAL_ROWS));
  const ts = new Date(base + jitter);

  const bucket = Math.floor(rng() * 1000);
  const severity = severityForBucket(bucket);
  const service = pick(rng, SERVICES);

  // Roughly 1 in 12 rows gets a rare fragment; the rest get common ones.
  const useRare = rng() < 1 / 12;
  const frag = useRare ? pick(rng, RARE_FRAGMENTS) : pick(rng, COMMON_FRAGMENTS);

  const template = pick(rng, TEMPLATES);
  const message = template
    .replace('{frag}', frag)
    .replace('{status}', String(pick(rng, STATUSES)))
    .replace('{ms}', String(Math.floor(rng() * 900) + 1))
    .replace('{ip}', `10.${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}`)
    .replace('{key}', `k_${Math.floor(rng() * 100000)}`)
    .replace('{order}', `ord_${Math.floor(rng() * 1000000)}`);

  return { ts, severity, service, message };
}
