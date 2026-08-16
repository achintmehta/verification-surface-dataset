const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'pgdata');

let db = null;

function getDB() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

// Simple seeded PRNG (mulberry32)
function mulberry32(seed) {
  return function() {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

async function initDB() {
  console.log('Initializing PGLite database...');
  db = new PGlite(DB_PATH);

  // Create table if not exists
  await db.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity VARCHAR(5) NOT NULL,
      service VARCHAR(50) NOT NULL,
      message TEXT NOT NULL
    )
  `);

  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*)::int AS cnt FROM logs');
  const existingCount = countResult.rows[0].cnt;

  if (existingCount >= 100000) {
    console.log(`Database already seeded with ${existingCount} rows. Skipping seed.`);
    // Ensure indexes exist
    await createIndexes();
    return;
  }

  if (existingCount > 0 && existingCount < 100000) {
    console.log(`Partial seed detected (${existingCount} rows). Clearing and reseeding...`);
    await db.query('DELETE FROM logs');
  }

  console.log('Seeding 100,000 log entries...');
  await seedLogs();
  await createIndexes();
  console.log('Seeding complete.');
}

async function createIndexes() {
  console.log('Creating indexes...');
  // Index for ordering by ts desc
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_ts_desc ON logs (ts DESC, id DESC)');
  // Index for severity + ts ordering
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC, id DESC)');
  // Trigram index for substring search - use btree on message for basic support
  // PGLite may not support pg_trgm, so we use a basic approach
  // For ILIKE queries, we'll rely on the ts index for ordering after filtering
  console.log('Indexes created.');
}

async function seedLogs() {
  const TOTAL = 100000;
  const BATCH_SIZE = 1000;
  const rng = mulberry32(42); // Deterministic seed

  const services = [
    'api-gateway',
    'auth-service',
    'user-service',
    'payment-service',
    'notification-service',
    'search-service',
    'inventory-service',
    'analytics-service'
  ];

  // Severity distribution: ~60% info, ~25% debug, ~10% warn, ~5% error
  const severityWeights = [
    { severity: 'info', weight: 0.60 },
    { severity: 'debug', weight: 0.25 },
    { severity: 'warn', weight: 0.10 },
    { severity: 'error', weight: 0.05 }
  ];

  // Message templates with variable fragments
  // Some terms are selective (rare), some are non-selective (common)
  const messageTemplates = [
    // Common/non-selective messages (~info/debug level)
    'Request processed successfully in {duration}ms',
    'Handling incoming request from {ip}',
    'Connection established to database pool',
    'Cache hit for key {cacheKey}',
    'Cache miss for key {cacheKey}, fetching from database',
    'Health check passed with status {status}',
    'Received heartbeat from {service}',
    'Processing batch job {jobId}',
    'Completed scheduled task in {duration}ms',
    'User {userId} authenticated successfully',
    'Session created for user {userId}',
    'Loading configuration from environment',
    'Initialized middleware pipeline',
    'Static assets served from CDN',
    'WebSocket connection opened from {ip}',

    // Moderately selective messages (~warn level)
    'Slow query detected: {duration}ms exceeds threshold',
    'Rate limit approaching for client {ip}',
    'Retry attempt {retryCount} for operation {operation}',
    'Deprecated API version used by client {ip}',
    'Memory usage at {memPercent}% of allocated heap',
    'Connection pool near capacity: {poolCount} of {poolMax}',

    // Selective messages (~error level)
    'CRITICAL: Unhandled exception in {operation}',
    'Failed to connect to upstream service {service}: timeout after {duration}ms',
    'Circuit breaker OPEN for {service}: {errorCount} consecutive failures',
    'Data integrity violation: duplicate entry for key {cacheKey}',
    'OutOfMemoryError: heap space exhausted during {operation}',
  ];

  const durations = ['12', '45', '89', '156', '234', '500', '1023', '2500', '5000', '15000'];
  const ips = ['192.168.1.100', '10.0.0.42', '172.16.0.15', '203.0.113.50', '198.51.100.7', '192.0.2.123'];
  const cacheKeys = ['user:1001', 'session:abc123', 'config:main', 'product:5678', 'rate:client99', 'token:xyz789'];
  const statuses = ['200', '201', '204', '301', '304'];
  const userIds = ['usr_1001', 'usr_2042', 'usr_3099', 'usr_4500', 'usr_5123', 'usr_6789', 'usr_7001', 'usr_8888'];
  const jobIds = ['batch_001', 'batch_042', 'batch_099', 'sync_daily', 'cleanup_weekly', 'report_gen'];
  const operations = ['fetchUserProfile', 'processPayment', 'sendNotification', 'updateInventory', 'generateReport', 'syncExternalData'];
  const retryCounts = ['1', '2', '3', '4', '5'];
  const memPercents = ['75', '82', '88', '91', '95'];
  const poolCounts = ['18', '19', '20'];
  const poolMaxes = ['20', '25'];
  const errorCounts = ['5', '10', '15', '20'];

  function pickRandom(arr) {
    return arr[Math.floor(rng() * arr.length)];
  }

  function pickSeverity() {
    const r = rng();
    let cumulative = 0;
    for (const sw of severityWeights) {
      cumulative += sw.weight;
      if (r < cumulative) return sw.severity;
    }
    return 'info';
  }

  function generateMessage() {
    const template = pickRandom(messageTemplates);
    return template
      .replace('{duration}', pickRandom(durations))
      .replace('{ip}', pickRandom(ips))
      .replace('{cacheKey}', pickRandom(cacheKeys))
      .replace('{status}', pickRandom(statuses))
      .replace('{service}', pickRandom(services))
      .replace('{userId}', pickRandom(userIds))
      .replace('{jobId}', pickRandom(jobIds))
      .replace('{operation}', pickRandom(operations))
      .replace('{retryCount}', pickRandom(retryCounts))
      .replace('{memPercent}', pickRandom(memPercents))
      .replace('{poolCount}', pickRandom(poolCounts))
      .replace('{poolMax}', pickRandom(poolMaxes))
      .replace('{errorCount}', pickRandom(errorCounts));
  }

  // Generate timestamps spanning 30 days
  const endDate = new Date('2025-01-30T23:59:59Z');
  const startDate = new Date('2025-01-01T00:00:00Z');
  const timeRange = endDate.getTime() - startDate.getTime();

  // Pre-generate all rows, sort by timestamp for batch insert
  const allRows = [];
  for (let i = 0; i < TOTAL; i++) {
    const ts = new Date(startDate.getTime() + rng() * timeRange);
    const severity = pickSeverity();
    const service = pickRandom(services);
    const message = generateMessage();
    allRows.push({ ts, severity, service, message });
  }

  // Sort by timestamp ascending for consistent ordering
  allRows.sort((a, b) => a.ts.getTime() - b.ts.getTime());

  // Batch insert
  for (let batch = 0; batch < TOTAL; batch += BATCH_SIZE) {
    const batchRows = allRows.slice(batch, batch + BATCH_SIZE);
    
    const valuePlaceholders = [];
    const params = [];
    let paramIdx = 1;

    for (const row of batchRows) {
      valuePlaceholders.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
      params.push(row.ts.toISOString(), row.severity, row.service, row.message);
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${valuePlaceholders.join(', ')}`;
    await db.query(sql, params);

    if ((batch + BATCH_SIZE) % 10000 === 0) {
      console.log(`  Seeded ${batch + BATCH_SIZE} / ${TOTAL} rows...`);
    }
  }
}

module.exports = { initDB, getDB };
