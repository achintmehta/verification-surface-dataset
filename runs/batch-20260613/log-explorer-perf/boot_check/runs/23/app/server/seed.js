// Deterministic seed for 100,000 log entries
// Uses a simple mulberry32 PRNG for reproducibility

function mulberry32(seed) {
  return function() {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const TOTAL_ROWS = 100000;
const BATCH_SIZE = 2000;

const SERVICES = [
  'api-gateway',
  'auth-service',
  'user-service',
  'payment-service',
  'notification-service',
  'search-service',
  'analytics-service',
  'file-service'
];

// Severity distribution: debug ~60%, info ~25%, warn ~10%, error ~5%
const SEVERITY_THRESHOLDS = [
  { severity: 'debug', cumulative: 0.60 },
  { severity: 'info',  cumulative: 0.85 },
  { severity: 'warn',  cumulative: 0.95 },
  { severity: 'error', cumulative: 1.00 }
];

// Message templates with variable fragments
// Some terms are selective (rare), some are non-selective (common)
const MESSAGE_TEMPLATES = [
  // Common/non-selective patterns
  'Processing request from client {ip}',
  'Request completed in {duration}ms',
  'Connection established from {ip}',
  'Health check passed successfully',
  'Cache hit for key {cacheKey}',
  'Cache miss for key {cacheKey}',
  'Database query executed in {duration}ms',
  'Received message on queue {queue}',
  'Sending response with status {status}',
  'Configuration reloaded successfully',
  // Moderately selective
  'User {userId} authenticated via {authMethod}',
  'Rate limit threshold reached for {ip}',
  'Retry attempt {retryNum} for operation {operation}',
  'Session {sessionId} expired after timeout',
  'Batch job {jobId} started processing {batchSize} items',
  'Memory usage at {memPercent}% of allocated heap',
  'Thread pool utilization at {poolPercent}%',
  'Outbound HTTP call to {endpoint} returned {status}',
  // Selective/rare patterns
  'CRITICAL: Disk space below threshold on volume {volume}',
  'Payment transaction {txnId} failed with code {errorCode}',
  'Circuit breaker OPEN for downstream {downstream}',
  'Deadlock detected in transaction {txnId}',
  'SSL certificate expiring in {days} days for {domain}',
  'Unhandled exception in worker {workerId}: NullPointerException',
  'Failover triggered: switching from primary to replica',
  'Data corruption detected in block {blockId} of partition {partition}',
];

const IPS = ['10.0.1.42', '10.0.2.88', '192.168.1.100', '172.16.0.55', '10.0.3.201', '10.0.1.17', '192.168.5.30', '172.16.2.99'];
const CACHE_KEYS = ['user:1001', 'session:abc', 'config:main', 'rate:10.0.1.42', 'token:xyz', 'product:5522', 'user:2048', 'settings:global'];
const QUEUES = ['orders', 'notifications', 'analytics', 'email', 'audit', 'sync'];
const STATUSES = ['200', '201', '204', '301', '400', '401', '403', '404', '500', '502', '503'];
const AUTH_METHODS = ['password', 'oauth2', 'saml', 'api-key', 'jwt'];
const OPERATIONS = ['saveOrder', 'sendEmail', 'syncInventory', 'generateReport', 'processPayment'];
const ENDPOINTS = ['/api/users', '/api/orders', '/api/products', '/api/health', '/api/search', '/internal/sync'];
const DOWNSTREAMS = ['payment-gateway', 'email-provider', 'sms-service', 'inventory-api', 'search-cluster'];
const DOMAINS = ['api.example.com', 'auth.example.com', 'cdn.example.com', 'ws.example.com'];
const VOLUMES = ['/dev/sda1', '/dev/sdb1', '/mnt/data', '/mnt/logs'];
const ERROR_CODES = ['DECLINED', 'TIMEOUT', 'INSUFFICIENT_FUNDS', 'INVALID_CARD', 'NETWORK_ERROR'];

function pickFrom(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

function fillTemplate(template, rng) {
  return template
    .replace('{ip}', pickFrom(IPS, rng))
    .replace('{duration}', String(Math.floor(rng() * 2000) + 1))
    .replace('{cacheKey}', pickFrom(CACHE_KEYS, rng))
    .replace('{queue}', pickFrom(QUEUES, rng))
    .replace('{status}', pickFrom(STATUSES, rng))
    .replace('{userId}', String(Math.floor(rng() * 10000) + 1))
    .replace('{authMethod}', pickFrom(AUTH_METHODS, rng))
    .replace('{sessionId}', 'sess_' + String(Math.floor(rng() * 100000)))
    .replace('{jobId}', 'job_' + String(Math.floor(rng() * 1000)))
    .replace('{batchSize}', String(Math.floor(rng() * 500) + 10))
    .replace('{retryNum}', String(Math.floor(rng() * 5) + 1))
    .replace('{operation}', pickFrom(OPERATIONS, rng))
    .replace('{memPercent}', String(Math.floor(rng() * 60) + 40))
    .replace('{poolPercent}', String(Math.floor(rng() * 50) + 50))
    .replace('{endpoint}', pickFrom(ENDPOINTS, rng))
    .replace('{txnId}', 'txn_' + String(Math.floor(rng() * 1000000)))
    .replace('{errorCode}', pickFrom(ERROR_CODES, rng))
    .replace('{downstream}', pickFrom(DOWNSTREAMS, rng))
    .replace('{days}', String(Math.floor(rng() * 30) + 1))
    .replace('{domain}', pickFrom(DOMAINS, rng))
    .replace('{workerId}', 'w-' + String(Math.floor(rng() * 16)))
    .replace('{volume}', pickFrom(VOLUMES, rng))
    .replace('{blockId}', String(Math.floor(rng() * 10000)))
    .replace('{partition}', 'p' + String(Math.floor(rng() * 8)));
}

async function seedDatabase(db) {
  const rng = mulberry32(42); // Deterministic seed

  // 30 days of logs, ending at a fixed date
  const endDate = new Date('2025-01-15T00:00:00Z');
  const startDate = new Date('2024-12-16T00:00:00Z');
  const timeSpanMs = endDate.getTime() - startDate.getTime();

  console.log(`[seed] Generating ${TOTAL_ROWS} log entries...`);
  const seedStart = Date.now();

  // Generate all timestamps first and sort them descending for ordered insertion
  const entries = [];
  for (let i = 0; i < TOTAL_ROWS; i++) {
    const tsOffset = rng() * timeSpanMs;
    const ts = new Date(startDate.getTime() + tsOffset);

    const sevRoll = rng();
    let severity = 'debug';
    for (const st of SEVERITY_THRESHOLDS) {
      if (sevRoll <= st.cumulative) {
        severity = st.severity;
        break;
      }
    }

    const service = pickFrom(SERVICES, rng);
    const template = pickFrom(MESSAGE_TEMPLATES, rng);
    const message = fillTemplate(template, rng);

    entries.push({ ts, severity, service, message });
  }

  // Sort by timestamp ascending for sequential insertion
  entries.sort((a, b) => a.ts.getTime() - b.ts.getTime());

  // Batch insert
  const totalBatches = Math.ceil(TOTAL_ROWS / BATCH_SIZE);
  for (let batch = 0; batch < totalBatches; batch++) {
    const start = batch * BATCH_SIZE;
    const end = Math.min(start + BATCH_SIZE, TOTAL_ROWS);
    const slice = entries.slice(start, end);

    // Build parameterized multi-row INSERT
    const values = [];
    const params = [];
    for (let i = 0; i < slice.length; i++) {
      const e = slice[i];
      const base = i * 4;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
      params.push(e.ts.toISOString(), e.severity, e.service, e.message);
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`;
    await db.query(sql, params);

    if ((batch + 1) % 10 === 0 || batch === totalBatches - 1) {
      console.log(`[seed] Inserted batch ${batch + 1}/${totalBatches} (${end} rows total)`);
    }
  }

  const elapsed = Date.now() - seedStart;
  console.log(`[seed] Seeding complete: ${TOTAL_ROWS} rows in ${elapsed}ms`);
}

module.exports = { seedDatabase };
