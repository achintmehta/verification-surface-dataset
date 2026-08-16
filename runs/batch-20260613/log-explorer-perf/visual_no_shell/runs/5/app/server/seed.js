/**
 * Deterministic seed of exactly 100,000 log entries.
 * Uses a simple LCG PRNG seeded at 42 for reproducibility.
 * Severities: ~60% debug, ~25% info, ~10% warn, ~5% error
 * 8 services, messages from templates with variable fragments
 * Timestamps span 30 days ending at a fixed epoch
 */

const TOTAL_ROWS = 100_000;
const BATCH_SIZE = 2_000;

const SERVICES = [
  'auth-service',
  'api-gateway',
  'user-service',
  'payment-service',
  'notification-service',
  'inventory-service',
  'search-service',
  'analytics-service',
];

const SEVERITIES = ['debug', 'debug', 'debug', 'debug', 'debug', 'debug',
                    'info', 'info', 'info', 'info', 'info',
                    'warn', 'warn',
                    'error'];
// 6/14 debug ≈ 42.8%, 5/14 info ≈ 35.7%, 2/14 warn ≈ 14.3%, 1/14 error ≈ 7.1%
// Adjusted to hit ~60/25/10/5:
const SEVERITY_WEIGHTS = [
  { sev: 'debug', weight: 60 },
  { sev: 'info',  weight: 25 },
  { sev: 'warn',  weight: 10 },
  { sev: 'error', weight: 5  },
];
const SEVERITY_TOTAL = 100;

// Message templates with placeholders
const MESSAGE_TEMPLATES = [
  // debug
  'Processing request {reqId} for user {userId}',
  'Cache hit for key {cacheKey} in {service}',
  'Database query executed in {ms}ms for table {table}',
  'Connection pool size: {poolSize} active, {idle} idle',
  'Received heartbeat from {host}:{port}',
  'Serializing response payload of {bytes} bytes',
  'Token validation passed for session {sessionId}',
  'Retry attempt {attempt} of {maxAttempts} for job {jobId}',
  'Queue depth: {depth} messages pending in {queue}',
  'Config loaded: {key}={value}',
  // info
  'User {userId} logged in from {ip}',
  'Order {orderId} created for customer {customerId}',
  'Payment {paymentId} processed successfully for {amount}',
  'Notification sent to {email} via {channel}',
  'Inventory updated: {sku} quantity changed to {qty}',
  'Search query "{term}" returned {count} results in {ms}ms',
  'Service {service} started on port {port}',
  'Deployment {deployId} completed for version {version}',
  'Scheduled job {jobName} completed in {ms}ms',
  'API rate limit: {used}/{limit} requests for key {apiKey}',
  // warn
  'Slow query detected: {ms}ms for {query}',
  'Memory usage at {pct}% of limit on {host}',
  'Retry limit approaching for job {jobId}: {attempt}/{maxAttempts}',
  'Deprecated endpoint {endpoint} called by {client}',
  'Cache miss rate elevated: {pct}% over last {window}s',
  'Connection pool exhausted for {db}, waiting {ms}ms',
  'Response time degraded: {ms}ms for {endpoint}',
  // error
  'Failed to connect to {host}:{port} after {attempt} retries',
  'Unhandled exception in {service}: {error}',
  'Payment {paymentId} failed: {reason}',
  'Database transaction rolled back for order {orderId}: {error}',
  'Authentication failed for user {userId}: {reason}',
];

// Variable fragment pools
const FRAGMENTS = {
  reqId:      () => `req-${rng(1000000)}`,
  userId:     () => `usr-${rng(50000)}`,
  cacheKey:   () => `ck:${['session','profile','product','cart','search'][rng(5)]}:${rng(10000)}`,
  service:    () => SERVICES[rng(SERVICES.length)],
  ms:         () => String(rng(5000)),
  table:      () => ['users','orders','payments','inventory','sessions','events'][rng(6)],
  poolSize:   () => String(rng(50)),
  idle:       () => String(rng(20)),
  host:       () => `10.0.${rng(10)}.${rng(255)}`,
  port:       () => String([3000,3001,5432,6379,8080,9200][rng(6)]),
  bytes:      () => String(rng(65536)),
  sessionId:  () => `sess-${rng(1000000)}`,
  attempt:    () => String(rng(5) + 1),
  maxAttempts:() => '5',
  jobId:      () => `job-${rng(100000)}`,
  depth:      () => String(rng(10000)),
  queue:      () => ['notifications','emails','payments','exports'][rng(4)],
  key:        () => ['MAX_CONNECTIONS','TIMEOUT_MS','RETRY_LIMIT','CACHE_TTL'][rng(4)],
  value:      () => String(rng(1000)),
  ip:         () => `192.168.${rng(255)}.${rng(255)}`,
  orderId:    () => `ord-${rng(1000000)}`,
  customerId: () => `cust-${rng(100000)}`,
  paymentId:  () => `pay-${rng(1000000)}`,
  amount:     () => `$${(rng(100000) / 100).toFixed(2)}`,
  email:      () => `user${rng(50000)}@example.com`,
  channel:    () => ['email','sms','push','webhook'][rng(4)],
  sku:        () => `SKU-${rng(10000)}`,
  qty:        () => String(rng(1000)),
  term:       () => ['login','checkout','search','profile','settings','error','timeout'][rng(7)],
  count:      () => String(rng(10000)),
  deployId:   () => `deploy-${rng(10000)}`,
  version:    () => `v${rng(10)}.${rng(20)}.${rng(100)}`,
  jobName:    () => ['cleanup','report','sync','backup','index'][rng(5)],
  apiKey:     () => `key-${rng(1000)}`,
  used:       () => String(rng(1000)),
  limit:      () => '1000',
  query:      () => `SELECT * FROM ${['users','orders','events'][rng(3)]} WHERE id=${rng(100000)}`,
  pct:        () => String(rng(100)),
  window:     () => String([60,300,900,3600][rng(4)]),
  db:         () => ['primary','replica','analytics'][rng(3)],
  endpoint:   () => [`/api/users/${rng(1000)}`,'/api/orders','/api/search','/api/payments'][rng(4)],
  client:     () => `client-${rng(500)}`,
  error:      () => ['NullPointerException','TimeoutError','ConnectionRefused','OutOfMemoryError','DivisionByZero'][rng(5)],
  reason:     () => ['invalid credentials','account locked','token expired','insufficient funds','card declined'][rng(5)],
};

// Simple LCG PRNG - mutable state
let _seed = 42;
function lcg() {
  _seed = (_seed * 1664525 + 1013904223) & 0xffffffff;
  return (_seed >>> 0) / 0x100000000;
}
function rng(max) {
  return Math.floor(lcg() * max);
}

function pickSeverity() {
  const r = rng(SEVERITY_TOTAL);
  let acc = 0;
  for (const { sev, weight } of SEVERITY_WEIGHTS) {
    acc += weight;
    if (r < acc) return sev;
  }
  return 'debug';
}

function renderTemplate(template) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const fn = FRAGMENTS[key];
    return fn ? fn() : key;
  });
}

// Fixed end time: 2024-01-30T00:00:00Z
const END_TS = new Date('2024-01-30T00:00:00Z').getTime();
const START_TS = END_TS - 30 * 24 * 60 * 60 * 1000; // 30 days earlier

export async function seed(db) {
  // Reset PRNG for determinism
  _seed = 42;

  // Generate all rows
  const rows = [];
  for (let i = 0; i < TOTAL_ROWS; i++) {
    const tsMs = START_TS + Math.floor(lcg() * (END_TS - START_TS));
    const ts = new Date(tsMs).toISOString();
    const severity = pickSeverity();
    const service = SERVICES[rng(SERVICES.length)];
    const template = MESSAGE_TEMPLATES[rng(MESSAGE_TEMPLATES.length)];
    const message = renderTemplate(template);
    rows.push({ ts, severity, service, message });
  }

  // Sort by ts ascending for natural insertion order (helps index locality)
  rows.sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);

  // Batch insert
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    const values = batch.map((r, i) => {
      const base = i * 4;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
    }).join(',\n');

    const params = batch.flatMap(r => [r.ts, r.severity, r.service, r.message]);

    await db.query(
      `INSERT INTO logs (ts, severity, service, message) VALUES ${values}`,
      params
    );

    if ((offset / BATCH_SIZE) % 10 === 0) {
      console.log(`  Inserted ${Math.min(offset + BATCH_SIZE, rows.length)} / ${rows.length} rows...`);
    }
  }

  console.log('Seed complete.');
}
