import { mulberry32 } from './rng.js';

export const SEVERITIES = ['debug', 'info', 'warn', 'error'];

// Roughly 60 / 25 / 10 / 5 distribution.
const SEVERITY_BUCKETS = [
  { sev: 'debug', threshold: 0.6 },
  { sev: 'info', threshold: 0.85 },
  { sev: 'warn', threshold: 0.95 },
  { sev: 'error', threshold: 1.0 },
];

export const SERVICES = [
  'auth-service',
  'payment-gateway',
  'user-api',
  'inventory-service',
  'notification-worker',
  'search-indexer',
  'billing-cron',
  'gateway-proxy',
];

// Message templates with variable fragments. Some fragments are selective
// (appear rarely) and some non-selective (appear often), so substring search
// can exercise both extremes.
const TEMPLATES = [
  'Request completed for user {uid} in {ms}ms',
  'Cache miss for key session:{uid}',
  'Connection pool acquired connection {conn}',
  'Payment {txn} authorized for amount {amt}',
  'Payment {txn} declined: insufficient funds',
  'User {uid} authenticated via {method}',
  'Token refresh failed for user {uid}',
  'Inventory item {sku} reserved quantity {qty}',
  'Inventory item {sku} out of stock',
  'Notification {ntf} dispatched to channel {chan}',
  'Search query indexed for document {doc}',
  'Rate limit exceeded for client {conn}',
  'Background job {txn} finished in {ms}ms',
  'Upstream timeout contacting {chan} after {ms}ms',
  'Configuration reloaded from source {method}',
];

const METHODS = ['oauth', 'password', 'sso', 'apikey'];
const CHANNELS = ['email', 'sms', 'push', 'webhook'];

const SPAN_DAYS = 30;
const SPAN_MS = SPAN_DAYS * 24 * 60 * 60 * 1000;
// A fixed reference "now" so timestamps are deterministic across boots.
const BASE_END = Date.UTC(2024, 0, 31, 0, 0, 0); // 2024-01-31T00:00:00Z
const BASE_START = BASE_END - SPAN_MS;

function pickSeverity(r) {
  for (const b of SEVERITY_BUCKETS) {
    if (r < b.threshold) return b.sev;
  }
  return 'error';
}

function fill(template, rand) {
  return template
    .replace('{uid}', String(1000 + Math.floor(rand() * 9000)))
    .replace('{ms}', String(1 + Math.floor(rand() * 800)))
    .replace('{conn}', 'c' + Math.floor(rand() * 64))
    .replace('{txn}', 'TXN' + (100000 + Math.floor(rand() * 900000)))
    .replace('{amt}', '$' + (1 + Math.floor(rand() * 5000)) + '.' + String(Math.floor(rand() * 100)).padStart(2, '0'))
    .replace('{method}', METHODS[Math.floor(rand() * METHODS.length)])
    .replace('{sku}', 'SKU-' + (1000 + Math.floor(rand() * 9000)))
    .replace('{qty}', String(1 + Math.floor(rand() * 50)))
    .replace('{ntf}', 'N' + (10000 + Math.floor(rand() * 90000)))
    .replace('{chan}', CHANNELS[Math.floor(rand() * CHANNELS.length)])
    .replace('{doc}', 'DOC-' + (10000 + Math.floor(rand() * 90000)));
}

/**
 * Generate exactly `count` deterministic log rows.
 * Timestamps are monotonically spread across the 30-day span (id order == ts order),
 * which keeps ts-ordered pagination clean and deterministic.
 * Yields arrays of [ts(ISO string), severity, service, message].
 */
export function* generateRows(count) {
  const rand = mulberry32(0x1234abcd);
  const step = SPAN_MS / count;
  for (let i = 0; i < count; i++) {
    // Deterministic timestamp with a little jitter, kept within the span.
    const jitter = Math.floor((rand() - 0.5) * step);
    let tms = Math.floor(BASE_START + i * step + jitter);
    if (tms < BASE_START) tms = BASE_START;
    if (tms >= BASE_END) tms = BASE_END - 1;

    const severity = pickSeverity(rand());
    const service = SERVICES[Math.floor(rand() * SERVICES.length)];
    const template = TEMPLATES[Math.floor(rand() * TEMPLATES.length)];
    const message = fill(template, rand);

    yield [new Date(tms).toISOString(), severity, service, message];
  }
}

export const SEED_META = {
  count: 100000,
  spanDays: SPAN_DAYS,
  services: SERVICES.length,
};
