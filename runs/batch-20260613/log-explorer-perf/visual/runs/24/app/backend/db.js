const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'pgdata');

let db;

// Deterministic pseudo-random number generator (mulberry32)
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOTAL_ROWS = 100000;
const SERVICES = ['auth-service', 'api-gateway', 'user-service', 'payment-service', 'notification-service', 'search-service', 'analytics-service', 'file-service'];

// Severity distribution: ~60% debug, ~25% info, ~10% warn, ~5% error
const SEVERITY_WEIGHTS = [
  { severity: 'debug', weight: 60 },
  { severity: 'info', weight: 25 },
  { severity: 'warn', weight: 10 },
  { severity: 'error', weight: 5 },
];
const TOTAL_WEIGHT = 100;

const MESSAGE_TEMPLATES = [
  // Selective terms (unique-ish fragments)
  'Request processed successfully in {ms}ms for endpoint {endpoint}',
  'Database connection established to replica {replica}',
  'Cache hit for key {key} with TTL {ttl}s remaining',
  'Cache miss for key {key}, fetching from database',
  'User {userId} authenticated via {method}',
  'Rate limit reached for IP {ip}, throttling requests',
  'Health check passed with status {status}',
  'Background job {jobId} completed in {ms}ms',
  'Failed to connect to upstream service after {retries} retries',
  'Configuration reloaded from {source}',
  // Non-selective terms (common fragments)
  'Processing request from client {clientId}',
  'Response sent with status code {statusCode}',
  'Incoming request to {endpoint} from {ip}',
  'Memory usage at {memory}MB, GC triggered',
  'Connection pool size: {poolSize} active, {poolIdle} idle',
  'Retrying operation, attempt {attempt} of {maxAttempts}',
  'Timeout waiting for response from {service}',
  'Payload size: {size} bytes',
  'Session {sessionId} expired after {ttl}s',
  'Webhook delivered to {url} with status {statusCode}',
];

const ENDPOINTS = ['/api/users', '/api/orders', '/api/products', '/api/auth/login', '/api/auth/refresh', '/api/payments', '/api/search', '/api/notifications', '/api/files/upload', '/api/health'];
const METHODS = ['password', 'oauth', 'token', 'sso', 'api-key'];
const SOURCES = ['env', 'consul', 'vault', 'file', 'etcd'];
const STATUS_CODES = ['200', '201', '204', '301', '400', '401', '403', '404', '500', '502', '503'];

function pickSeverity(rand) {
  const r = rand() * TOTAL_WEIGHT;
  let cumulative = 0;
  for (const { severity, weight } of SEVERITY_WEIGHTS) {
    cumulative += weight;
    if (r < cumulative) return severity;
  }
  return 'debug';
}

function fillTemplate(template, rand) {
  return template
    .replace('{ms}', Math.floor(rand() * 2000).toString())
    .replace('{endpoint}', ENDPOINTS[Math.floor(rand() * ENDPOINTS.length)])
    .replace('{replica}', `replica-${Math.floor(rand() * 5)}`)
    .replace('{key}', `cache:${SERVICES[Math.floor(rand() * SERVICES.length)]}:${Math.floor(rand() * 10000)}`)
    .replace('{ttl}', Math.floor(rand() * 3600).toString())
    .replace('{userId}', `user-${Math.floor(rand() * 50000)}`)
    .replace('{method}', METHODS[Math.floor(rand() * METHODS.length)])
    .replace('{ip}', `${Math.floor(rand() * 256)}.${Math.floor(rand() * 256)}.${Math.floor(rand() * 256)}.${Math.floor(rand() * 256)}`)
    .replace('{status}', rand() > 0.1 ? 'healthy' : 'degraded')
    .replace('{jobId}', `job-${Math.floor(rand() * 100000)}`)
    .replace('{retries}', Math.floor(rand() * 5 + 1).toString())
    .replace('{source}', SOURCES[Math.floor(rand() * SOURCES.length)])
    .replace('{clientId}', `client-${Math.floor(rand() * 1000)}`)
    .replace('{statusCode}', STATUS_CODES[Math.floor(rand() * STATUS_CODES.length)])
    .replace('{memory}', Math.floor(rand() * 512 + 64).toString())
    .replace('{poolSize}', Math.floor(rand() * 20 + 1).toString())
    .replace('{poolIdle}', Math.floor(rand() * 10).toString())
    .replace('{attempt}', Math.floor(rand() * 3 + 1).toString())
    .replace('{maxAttempts}', '3')
    .replace('{service}', SERVICES[Math.floor(rand() * SERVICES.length)])
    .replace('{size}', Math.floor(rand() * 100000).toString())
    .replace('{sessionId}', `sess-${Math.floor(rand() * 100000)}`)
    .replace('{url}', `https://hooks.example.com/webhook/${Math.floor(rand() * 1000)}`);
}

function generateRow(index, rand) {
  // Spread across 30 days, most recent first in generation
  // Base time: 30 days ago. Rows span 30 days.
  const baseTime = new Date('2025-01-01T00:00:00Z').getTime();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  const ts = new Date(baseTime + rand() * thirtyDays);

  const severity = pickSeverity(rand);
  const service = SERVICES[Math.floor(rand() * SERVICES.length)];
  const template = MESSAGE_TEMPLATES[Math.floor(rand() * MESSAGE_TEMPLATES.length)];
  const message = fillTemplate(template, rand);

  return { ts, severity, service, message };
}

async function initDB() {
  db = new PGlite(DB_PATH);

  // Create table if not exists
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL,
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);

  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*)::int AS cnt FROM logs');
  const existingCount = countResult.rows[0].cnt;

  if (existingCount >= TOTAL_ROWS) {
    console.log(`Table already seeded with ${existingCount} rows, skipping seed.`);
    // Ensure indexes exist
    await ensureIndexes();
    return;
  }

  if (existingCount > 0) {
    console.log(`Partial seed detected (${existingCount} rows), clearing and re-seeding...`);
    await db.exec('TRUNCATE logs RESTART IDENTITY');
  }

  console.log(`Seeding ${TOTAL_ROWS} rows...`);
  const rand = mulberry32(42); // deterministic seed

  const BATCH_SIZE = 2000;
  let seeded = 0;

  while (seeded < TOTAL_ROWS) {
    const batchEnd = Math.min(seeded + BATCH_SIZE, TOTAL_ROWS);
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (let i = seeded; i < batchEnd; i++) {
      const row = generateRow(i, rand);
      values.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3})`);
      params.push(row.ts.toISOString(), row.severity, row.service, row.message);
      paramIdx += 4;
    }

    await db.query(
      `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')}`,
      params
    );

    seeded = batchEnd;
    if (seeded % 10000 === 0) {
      console.log(`  Seeded ${seeded}/${TOTAL_ROWS} rows...`);
    }
  }

  console.log('Seeding complete. Creating indexes...');
  await ensureIndexes();
  console.log('Indexes created.');
}

async function ensureIndexes() {
  // Index for ordering by ts descending (supports all queries)
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC)');
  // Index for severity + ts ordering
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC)');
  // Trigram index for substring search - PGLite may not support pg_trgm,
  // so we use a regular btree on lower(message) for prefix optimization, 
  // but substring search will rely on sequential scan with the ts index.
  // For substring matching, we'll use ILIKE which benefits from severity filter narrowing.
  // Let's create a combined index for severity + ts which helps when both filters are applied
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_service_ts ON logs (service, ts DESC)');
}

async function queryLogs({ offset, limit, severity, search }) {
  const conditions = [];
  const params = [];
  let paramIdx = 1;

  if (severity) {
    conditions.push(`severity = $${paramIdx}`);
    params.push(severity);
    paramIdx++;
  }

  if (search) {
    conditions.push(`message ILIKE $${paramIdx}`);
    params.push(`%${search}%`);
    paramIdx++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Get total count
  const countQuery = `SELECT COUNT(*)::int AS total FROM logs ${whereClause}`;
  const countResult = await db.query(countQuery, params);
  const total = countResult.rows[0].total;

  // Get rows for the window
  const dataParams = [...params, limit, offset];
  const dataQuery = `SELECT id, ts, severity, service, message FROM logs ${whereClause} ORDER BY ts DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
  const dataResult = await db.query(dataQuery, dataParams);

  return {
    total,
    rows: dataResult.rows,
  };
}

async function queryStats() {
  const totalResult = await db.query('SELECT COUNT(*)::int AS total FROM logs');
  const severityResult = await db.query(
    `SELECT severity, COUNT(*)::int AS count FROM logs GROUP BY severity ORDER BY 
     CASE severity WHEN 'debug' THEN 1 WHEN 'info' THEN 2 WHEN 'warn' THEN 3 WHEN 'error' THEN 4 END`
  );

  const severities = {};
  for (const row of severityResult.rows) {
    severities[row.severity] = row.count;
  }

  return {
    total: totalResult.rows[0].total,
    severities,
  };
}

module.exports = { initDB, queryLogs, queryStats };
