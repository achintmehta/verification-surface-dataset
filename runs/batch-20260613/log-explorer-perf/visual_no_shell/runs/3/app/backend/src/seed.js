/**
 * Deterministic seed generator for 100,000 log entries.
 * Uses a simple LCG (linear congruential generator) for determinism.
 */

const SEVERITIES = ['debug', 'info', 'warn', 'error'];
// Roughly 60/25/10/5 distribution
const SEVERITY_WEIGHTS = [60, 25, 10, 5];
const SEVERITY_CUMULATIVE = [60, 85, 95, 100];

const SERVICES = [
  'api-gateway',
  'auth-service',
  'user-service',
  'payment-service',
  'notification-service',
  'inventory-service',
  'search-service',
  'analytics-service',
];

const MESSAGE_TEMPLATES = [
  // Debug templates
  'Processing request {id} from client {client}',
  'Cache hit for key {key} in {service}',
  'Database query executed in {ms}ms for table {table}',
  'Connection pool size: {size}, active: {active}',
  'Retry attempt {attempt} for operation {op}',
  'Serializing response object with {fields} fields',
  'Deserialized payload of {bytes} bytes',
  'Middleware {name} executed in {ms}ms',
  'Session {session} validated successfully',
  'Config loaded: {key}={value}',

  // Info templates
  'User {user} logged in from {ip}',
  'Request {method} {path} completed with status {status}',
  'Order {order} placed successfully for user {user}',
  'Payment {payment} processed for amount {amount}',
  'Email notification sent to {email}',
  'Service {service} started on port {port}',
  'Health check passed for {service}',
  'Scheduled job {job} completed in {ms}ms',
  'File {file} uploaded successfully ({bytes} bytes)',
  'API rate limit: {used}/{limit} requests used',
  'Cache refreshed for {key} with TTL {ttl}s',
  'Database migration {version} applied successfully',

  // Warn templates
  'High memory usage detected: {percent}% on {host}',
  'Slow query detected: {ms}ms for {query}',
  'Rate limit approaching for user {user}: {used}/{limit}',
  'Deprecated API endpoint {path} called by {client}',
  'Retry {attempt}/{max} for {service} connection',
  'Cache miss rate elevated: {percent}% in last {window}s',
  'Disk usage at {percent}% on {host}',
  'Response time degraded: {ms}ms for {path}',

  // Error templates
  'Failed to connect to database after {attempts} attempts',
  'Unhandled exception in {service}: {error}',
  'Payment {payment} failed: {reason}',
  'Authentication failed for user {user} from {ip}',
  'Service {service} unavailable: {error}',
  'Request timeout after {ms}ms for {path}',
  'Data validation failed for {field}: {error}',
  'Circuit breaker opened for {service} after {failures} failures',
];

const VARIABLE_FRAGMENTS = {
  id: () => `req-${lcgNext() % 999999}`,
  client: () => `client-${lcgNext() % 1000}`,
  key: () => `cache:${['user', 'session', 'product', 'order'][lcgNext() % 4]}:${lcgNext() % 10000}`,
  service: () => SERVICES[lcgNext() % SERVICES.length],
  ms: () => String(lcgNext() % 5000),
  table: () => ['users', 'orders', 'products', 'sessions', 'payments'][lcgNext() % 5],
  size: () => String(lcgNext() % 100),
  active: () => String(lcgNext() % 50),
  attempt: () => String((lcgNext() % 5) + 1),
  op: () => ['read', 'write', 'delete', 'update'][lcgNext() % 4],
  fields: () => String(lcgNext() % 50),
  bytes: () => String(lcgNext() % 1048576),
  name: () => ['auth', 'logging', 'cors', 'ratelimit', 'compress'][lcgNext() % 5],
  session: () => `sess-${lcgNext() % 99999}`,
  value: () => String(lcgNext() % 1000),
  user: () => `user-${lcgNext() % 50000}`,
  ip: () => `${(lcgNext() % 254) + 1}.${lcgNext() % 256}.${lcgNext() % 256}.${lcgNext() % 256}`,
  method: () => ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'][lcgNext() % 5],
  path: () => ['/', '/api/users', '/api/orders', '/api/products', '/api/payments', '/api/auth', '/health'][lcgNext() % 7],
  status: () => ['200', '201', '400', '401', '403', '404', '500'][lcgNext() % 7],
  order: () => `ord-${lcgNext() % 999999}`,
  payment: () => `pay-${lcgNext() % 999999}`,
  amount: () => `$${((lcgNext() % 100000) / 100).toFixed(2)}`,
  email: () => `user${lcgNext() % 50000}@example.com`,
  port: () => String(3000 + (lcgNext() % 3000)),
  job: () => ['cleanup', 'report', 'sync', 'backup', 'notify'][lcgNext() % 5],
  file: () => `upload-${lcgNext() % 99999}.bin`,
  used: () => String(lcgNext() % 1000),
  limit: () => String(1000 + (lcgNext() % 9000)),
  ttl: () => String(lcgNext() % 3600),
  version: () => `v${lcgNext() % 100}`,
  percent: () => String(lcgNext() % 100),
  host: () => `host-${lcgNext() % 20}`,
  query: () => `SELECT * FROM ${['users', 'orders', 'products'][lcgNext() % 3]}`,
  max: () => String((lcgNext() % 5) + 3),
  window: () => String(lcgNext() % 300),
  attempts: () => String((lcgNext() % 5) + 1),
  error: () => ['Connection refused', 'Timeout', 'Out of memory', 'Disk full', 'Permission denied'][lcgNext() % 5],
  reason: () => ['Insufficient funds', 'Card declined', 'Expired card', 'Invalid CVV'][lcgNext() % 4],
  field: () => ['email', 'username', 'password', 'phone', 'address'][lcgNext() % 5],
  failures: () => String((lcgNext() % 10) + 5),
};

// LCG state - mutable for generation
let lcgState = 0;

function lcgSeed(s) {
  lcgState = s >>> 0;
}

function lcgNext() {
  // LCG parameters from Numerical Recipes
  lcgState = ((lcgState * 1664525 + 1013904223) >>> 0);
  return lcgState;
}

function pickSeverity() {
  const r = lcgNext() % 100;
  for (let i = 0; i < SEVERITY_CUMULATIVE.length; i++) {
    if (r < SEVERITY_CUMULATIVE[i]) return SEVERITIES[i];
  }
  return 'info';
}

function fillTemplate(template) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const fn = VARIABLE_FRAGMENTS[key];
    return fn ? fn() : key;
  });
}

/**
 * Generate all 100,000 log entries as arrays for batch insertion.
 * Returns an array of batches, each batch being an array of row tuples.
 */
export function generateSeedBatches(totalRows = 100000, batchSize = 1000) {
  lcgSeed(42); // deterministic seed

  // 30 days span
  const endTime = new Date('2024-01-31T23:59:59Z').getTime();
  const startTime = new Date('2024-01-01T00:00:00Z').getTime();
  const timeRange = endTime - startTime;

  const batches = [];
  let currentBatch = [];

  for (let i = 0; i < totalRows; i++) {
    // Deterministic timestamp spread across 30 days
    const tsOffset = (lcgNext() / 0xFFFFFFFF) * timeRange;
    const ts = new Date(startTime + tsOffset).toISOString();

    const severity = pickSeverity();
    const service = SERVICES[lcgNext() % SERVICES.length];
    const templateIdx = lcgNext() % MESSAGE_TEMPLATES.length;
    const message = fillTemplate(MESSAGE_TEMPLATES[templateIdx]);

    currentBatch.push([ts, severity, service, message]);

    if (currentBatch.length >= batchSize) {
      batches.push(currentBatch);
      currentBatch = [];
    }
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}
