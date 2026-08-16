/**
 * Deterministic seed of 100,000 log entries.
 *
 * - Spans 30 days back from a fixed epoch (2025-01-31T00:00:00Z)
 * - 8 services
 * - Severity distribution: debug ~60%, info ~25%, warn ~10%, error ~5%
 * - Messages from templates with variable fragments for selective/non-selective search
 */

const TOTAL_ROWS = 100_000;

const SERVICES = [
  'api-gateway',
  'auth-service',
  'user-service',
  'order-service',
  'payment-service',
  'notification-service',
  'inventory-service',
  'analytics-service',
];

const SEVERITIES = ['debug', 'info', 'warn', 'error'];
// Cumulative thresholds out of 100 for 60/25/10/5 distribution
const SEVERITY_THRESHOLDS = [60, 85, 95, 100];

const MESSAGE_TEMPLATES = [
  'Request processed successfully in {duration}ms',
  'Connection established to {host}:{port}',
  'Cache miss for key {cacheKey}',
  'User {userId} authenticated via {authMethod}',
  'Database query completed in {duration}ms',
  'Rate limit threshold reached for client {clientId}',
  'Health check passed with status {status}',
  'Retry attempt {attempt} for operation {operation}',
  'Configuration reloaded from {configSource}',
  'Memory usage at {memPercent}% of allocated heap',
  'Outbound request to {endpoint} returned {statusCode}',
  'Processing batch job {jobId} with {batchSize} items',
  'SSL certificate expires in {days} days',
  'Garbage collection paused for {gcPause}ms',
  'WebSocket connection opened from {remoteAddr}',
  'Scheduled task {taskName} triggered at {triggerTime}',
  'File upload received: {fileName} ({fileSize}KB)',
  'Queue depth for {queueName} is {queueDepth}',
  'Deployment version {version} rolling out',
  'Circuit breaker {state} for downstream {downstream}',
];

const HOSTS = ['db-primary', 'db-replica', 'cache-01', 'cache-02', 'mq-broker'];
const PORTS = ['5432', '6379', '5672', '8080', '3306'];
const AUTH_METHODS = ['oauth2', 'api-key', 'jwt', 'basic', 'saml'];
const OPERATIONS = ['sendEmail', 'processPayment', 'syncInventory', 'generateReport'];
const CONFIG_SOURCES = ['consul', 'vault', 'env', 'configmap'];
const ENDPOINTS = ['/api/users', '/api/orders', '/api/products', '/api/payments', '/healthz'];
const STATUS_CODES = ['200', '201', '204', '301', '400', '403', '404', '500', '502', '503'];
const QUEUE_NAMES = ['order-events', 'email-queue', 'audit-log', 'notifications'];
const TASK_NAMES = ['cleanup', 'aggregation', 'backup', 'indexRebuild', 'reportGen'];
const STATES = ['open', 'closed', 'half-open'];
const DOWNSTREAMS = ['payment-gateway', 'email-provider', 'sms-provider', 'search-cluster'];
const FILE_NAMES = ['report.csv', 'backup.tar.gz', 'import.xlsx', 'config.yaml', 'data.json'];

// Simple deterministic PRNG (mulberry32)
function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickFromRng(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function fillTemplate(rng, template) {
  return template.replace(/\{(\w+)\}/g, (_m, key) => {
    switch (key) {
      case 'duration':    return String(Math.floor(rng() * 2000));
      case 'host':        return pickFromRng(rng, HOSTS);
      case 'port':        return pickFromRng(rng, PORTS);
      case 'cacheKey':    return 'key-' + Math.floor(rng() * 10000);
      case 'userId':      return 'usr-' + Math.floor(rng() * 5000);
      case 'authMethod':  return pickFromRng(rng, AUTH_METHODS);
      case 'clientId':    return 'client-' + Math.floor(rng() * 200);
      case 'status':      return rng() > 0.1 ? 'ok' : 'degraded';
      case 'attempt':     return String(Math.floor(rng() * 5) + 1);
      case 'operation':   return pickFromRng(rng, OPERATIONS);
      case 'configSource': return pickFromRng(rng, CONFIG_SOURCES);
      case 'memPercent':  return String(Math.floor(rng() * 80) + 10);
      case 'endpoint':    return pickFromRng(rng, ENDPOINTS);
      case 'statusCode':  return pickFromRng(rng, STATUS_CODES);
      case 'jobId':       return 'job-' + Math.floor(rng() * 1000);
      case 'batchSize':   return String(Math.floor(rng() * 500) + 10);
      case 'days':        return String(Math.floor(rng() * 90) + 1);
      case 'gcPause':     return String(Math.floor(rng() * 200) + 5);
      case 'remoteAddr':  return `192.168.${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}`;
      case 'taskName':    return pickFromRng(rng, TASK_NAMES);
      case 'triggerTime': return `${String(Math.floor(rng() * 24)).padStart(2, '0')}:${String(Math.floor(rng() * 60)).padStart(2, '0')}`;
      case 'fileName':    return pickFromRng(rng, FILE_NAMES);
      case 'fileSize':    return String(Math.floor(rng() * 10000) + 1);
      case 'queueName':   return pickFromRng(rng, QUEUE_NAMES);
      case 'queueDepth':  return String(Math.floor(rng() * 5000));
      case 'version':     return `v${Math.floor(rng() * 5) + 1}.${Math.floor(rng() * 20)}.${Math.floor(rng() * 100)}`;
      case 'state':       return pickFromRng(rng, STATES);
      case 'downstream':  return pickFromRng(rng, DOWNSTREAMS);
      default:            return key;
    }
  });
}

export async function seedIfNeeded(db) {
  // Check if table exists and has data
  const tableCheck = await db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables WHERE table_name = 'logs'
    ) AS table_exists
  `);

  if (tableCheck.rows[0].table_exists) {
    const countResult = await db.query('SELECT COUNT(*)::int AS cnt FROM logs');
    if (countResult.rows[0].cnt >= TOTAL_ROWS) {
      console.log(`[seed] Table already has ${countResult.rows[0].cnt} rows, skipping seed.`);
      return false; // no seeding performed
    }
    // Table exists but incomplete – truncate and reseed
    await db.query('TRUNCATE logs');
  } else {
    // Create table
    await db.query(`
      CREATE TABLE logs (
        id SERIAL PRIMARY KEY,
        ts TIMESTAMPTZ NOT NULL,
        severity TEXT NOT NULL,
        service TEXT NOT NULL,
        message TEXT NOT NULL
      )
    `);
  }

  console.log(`[seed] Seeding ${TOTAL_ROWS} rows...`);
  const startTime = Date.now();

  const rng = mulberry32(42); // deterministic seed

  // Epoch: 2025-01-31T00:00:00Z
  const epochMs = new Date('2025-01-31T00:00:00Z').getTime();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  // Generate all rows in memory first, then batch insert
  const BATCH_SIZE = 2000;

  for (let batchStart = 0; batchStart < TOTAL_ROWS; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL_ROWS);
    const batchCount = batchEnd - batchStart;

    // Build a multi-row VALUES clause
    const values = [];
    const params = [];
    for (let i = 0; i < batchCount; i++) {
      const rowIndex = batchStart + i;
      // Timestamp: spread across 30 days, ordered by row index for determinism
      const tsMs = epochMs - thirtyDaysMs + (rowIndex / TOTAL_ROWS) * thirtyDaysMs;
      const ts = new Date(tsMs).toISOString();

      // Severity based on distribution
      const sevRoll = rng() * 100;
      let severity;
      if (sevRoll < 60) severity = 'debug';
      else if (sevRoll < 85) severity = 'info';
      else if (sevRoll < 95) severity = 'warn';
      else severity = 'error';

      const service = pickFromRng(rng, SERVICES);
      const template = pickFromRng(rng, MESSAGE_TEMPLATES);
      const message = fillTemplate(rng, template);

      const paramOffset = i * 4;
      values.push(`($${paramOffset + 1}, $${paramOffset + 2}, $${paramOffset + 3}, $${paramOffset + 4})`);
      params.push(ts, severity, service, message);
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`;
    await db.query(sql, params);

    if ((batchStart + BATCH_SIZE) % 20000 === 0 || batchEnd === TOTAL_ROWS) {
      console.log(`[seed] Inserted ${batchEnd} / ${TOTAL_ROWS} rows (${Date.now() - startTime}ms elapsed)`);
    }
  }

  // Create indexes
  console.log('[seed] Creating indexes...');
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC)');
  // trigram or pattern index for ILIKE — PGlite may not support pg_trgm,
  // so we create a btree index on lower(message) for direct comparisons
  // and rely on the ts ordering index for ILIKE queries (which will still
  // be reasonably fast at 100k rows with index on ts for ordering).
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_message_lower ON logs (lower(message) text_pattern_ops)');

  const elapsed = Date.now() - startTime;
  console.log(`[seed] Seeding complete in ${elapsed}ms`);
  return true;
}
