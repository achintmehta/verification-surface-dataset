const TOTAL_ROWS = 100000;
const BATCH_SIZE = 2000;

const SERVICES = [
  'api-gateway',
  'auth-service',
  'user-service',
  'order-service',
  'payment-service',
  'notification-service',
  'inventory-service',
  'analytics-service'
];

// Severity distribution: ~60% info, ~25% debug, ~10% warn, ~5% error
const SEVERITY_POOL = [];
for (let i = 0; i < 60; i++) SEVERITY_POOL.push('info');
for (let i = 0; i < 25; i++) SEVERITY_POOL.push('debug');
for (let i = 0; i < 10; i++) SEVERITY_POOL.push('warn');
for (let i = 0; i < 5; i++) SEVERITY_POOL.push('error');

const MESSAGE_TEMPLATES = [
  'Request processed successfully in {duration}ms',
  'Connection established to {target} endpoint',
  'Cache miss for key {key}, fetching from database',
  'User {userId} authenticated via {method}',
  'Rate limit threshold reached for client {clientId}',
  'Database query executed in {duration}ms, returned {count} rows',
  'Health check passed with status {status}',
  'Retry attempt {attempt} for operation {operation}',
  'Configuration reloaded from {source}',
  'Memory usage at {percent}% of allocated heap',
  'Outbound HTTP request to {target} completed with status {httpStatus}',
  'Session {sessionId} expired after {duration}ms of inactivity',
  'File upload received: {filename}, size {size}KB',
  'Scheduled task {taskName} started execution',
  'WebSocket connection opened from {clientIp}',
  'Payment transaction {txId} processed for amount {amount}',
  'Inventory check for SKU {sku} returned {count} units',
  'Notification dispatched to {channel} for user {userId}',
  'Search query "{searchTerm}" returned {count} results in {duration}ms',
  'Circuit breaker {state} for service {target}'
];

const TARGETS = ['upstream-api', 'postgres-primary', 'redis-cache', 'elasticsearch', 'rabbitmq', 'kafka-broker', 's3-storage', 'auth-provider'];
const METHODS = ['oauth2', 'jwt', 'api-key', 'saml', 'basic-auth'];
const OPERATIONS = ['fetchUserProfile', 'processPayment', 'sendNotification', 'updateInventory', 'generateReport', 'syncData'];
const SOURCES = ['consul', 'vault', 'env-vars', 'config-server', 'local-file'];
const CHANNELS = ['email', 'sms', 'push', 'slack', 'webhook'];
const STATES = ['opened', 'closed', 'half-open'];
const SEARCH_TERMS = ['laptop', 'wireless mouse', 'USB cable', 'monitor stand', 'keyboard'];
const TASK_NAMES = ['cleanup-expired-sessions', 'sync-inventory', 'generate-daily-report', 'flush-metrics', 'rotate-logs'];
const FILENAMES = ['report.pdf', 'avatar.png', 'data-export.csv', 'backup.tar.gz', 'config.yaml'];
const HTTP_STATUSES = ['200', '201', '301', '400', '403', '404', '500', '502', '503'];

// Simple deterministic PRNG (mulberry32)
function mulberry32(seed) {
  return function() {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function generateRow(index, rng) {
  // Timestamps spanning 30 days, roughly ordered but with jitter
  const baseTime = new Date('2024-01-01T00:00:00Z').getTime();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  // Spread entries across 30 days with small random jitter
  const fraction = index / TOTAL_ROWS;
  const jitter = (rng() - 0.5) * 60000; // ±30 seconds jitter
  const ts = new Date(baseTime + fraction * thirtyDays + jitter);

  const severity = SEVERITY_POOL[Math.floor(rng() * SEVERITY_POOL.length)];
  const service = SERVICES[Math.floor(rng() * SERVICES.length)];
  const templateIndex = Math.floor(rng() * MESSAGE_TEMPLATES.length);
  let message = MESSAGE_TEMPLATES[templateIndex];

  // Replace placeholders deterministically
  message = message.replace('{duration}', Math.floor(rng() * 5000));
  message = message.replace('{target}', TARGETS[Math.floor(rng() * TARGETS.length)]);
  message = message.replace('{key}', 'cache:' + Math.floor(rng() * 10000));
  message = message.replace('{userId}', 'user-' + Math.floor(rng() * 1000));
  message = message.replace('{method}', METHODS[Math.floor(rng() * METHODS.length)]);
  message = message.replace('{clientId}', 'client-' + Math.floor(rng() * 500));
  message = message.replace('{count}', Math.floor(rng() * 1000));
  message = message.replace('{status}', rng() > 0.1 ? 'OK' : 'DEGRADED');
  message = message.replace('{attempt}', Math.floor(rng() * 5) + 1);
  message = message.replace('{operation}', OPERATIONS[Math.floor(rng() * OPERATIONS.length)]);
  message = message.replace('{source}', SOURCES[Math.floor(rng() * SOURCES.length)]);
  message = message.replace('{percent}', Math.floor(rng() * 100));
  message = message.replace('{httpStatus}', HTTP_STATUSES[Math.floor(rng() * HTTP_STATUSES.length)]);
  message = message.replace('{sessionId}', 'sess-' + Math.floor(rng() * 100000));
  message = message.replace('{filename}', FILENAMES[Math.floor(rng() * FILENAMES.length)]);
  message = message.replace('{size}', Math.floor(rng() * 50000));
  message = message.replace('{taskName}', TASK_NAMES[Math.floor(rng() * TASK_NAMES.length)]);
  message = message.replace('{clientIp}', `192.168.${Math.floor(rng() * 256)}.${Math.floor(rng() * 256)}`);
  message = message.replace('{txId}', 'tx-' + Math.floor(rng() * 1000000));
  message = message.replace('{amount}', (rng() * 10000).toFixed(2));
  message = message.replace('{sku}', 'SKU-' + Math.floor(rng() * 5000));
  message = message.replace('{channel}', CHANNELS[Math.floor(rng() * CHANNELS.length)]);
  message = message.replace('{searchTerm}', SEARCH_TERMS[Math.floor(rng() * SEARCH_TERMS.length)]);
  message = message.replace('{state}', STATES[Math.floor(rng() * STATES.length)]);

  return { ts, severity, service, message };
}

function escapeStr(s) {
  // Escape single quotes and backslashes for SQL
  return s.replace(/\\/g, '\\\\').replace(/'/g, "''");
}

async function seedDatabase(db) {
  console.log(`Seeding ${TOTAL_ROWS} log entries in batches of ${BATCH_SIZE}...`);
  console.time('seed');

  const rng = mulberry32(42); // deterministic seed

  for (let batchStart = 0; batchStart < TOTAL_ROWS; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL_ROWS);
    const values = [];

    for (let i = batchStart; i < batchEnd; i++) {
      const row = generateRow(i, rng);
      values.push(
        `('${row.ts.toISOString()}','${escapeStr(row.severity)}','${escapeStr(row.service)}','${escapeStr(row.message)}')`
      );
    }

    await db.query(`INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')}`);

    if ((batchStart / BATCH_SIZE) % 10 === 0) {
      console.log(`  Seeded ${batchEnd} / ${TOTAL_ROWS} rows...`);
    }
  }

  console.timeEnd('seed');
  console.log('Seeding complete.');
}

module.exports = { seedDatabase };
