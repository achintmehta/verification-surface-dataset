const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'pgdata');

// Deterministic PRNG (mulberry32)
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function initDB() {
  const db = new PGlite(DB_PATH);

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

  if (existingCount >= 100000) {
    console.log(`Database already seeded with ${existingCount} rows, skipping seed.`);
    // Ensure indexes exist even on subsequent boots
    await ensureIndexes(db);
    return db;
  }

  if (existingCount > 0 && existingCount < 100000) {
    console.log(`Partial seed detected (${existingCount} rows), clearing and reseeding...`);
    await db.exec('TRUNCATE logs RESTART IDENTITY');
  }

  console.log('Seeding 100,000 log entries...');
  console.time('seed');
  await seedLogs(db);
  console.timeEnd('seed');

  await ensureIndexes(db);

  return db;
}

async function ensureIndexes(db) {
  console.time('indexes');
  // Index for ordering by timestamp desc (default query)
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC)');
  // Index for severity filter + timestamp ordering
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC)');
  // Trigram index alternative: since PGLite may not support pg_trgm,
  // we use a btree index on lower(message) for prefix matching
  // For substring search, we'll rely on the severity+ts index reducing scan scope
  // and add a basic index on message for potential use
  // Actually, for ILIKE '%text%' queries, btree indexes won't help.
  // We'll need to handle this with efficient scanning.
  // Let's just make sure the main indexes are solid.
  console.timeEnd('indexes');
}

async function seedLogs(db) {
  const rng = mulberry32(42);
  const TOTAL = 100000;
  const BATCH_SIZE = 2000;

  const services = [
    'api-gateway',
    'auth-service',
    'user-service',
    'payment-service',
    'notification-service',
    'search-service',
    'analytics-service',
    'storage-service'
  ];

  // Severity distribution: 60% debug, 25% info, 10% warn, 5% error
  const severityBuckets = [];
  for (let i = 0; i < 60; i++) severityBuckets.push('debug');
  for (let i = 0; i < 25; i++) severityBuckets.push('info');
  for (let i = 0; i < 10; i++) severityBuckets.push('warn');
  for (let i = 0; i < 5; i++) severityBuckets.push('error');

  // Message templates with variable fragments
  // Some terms are selective (rare), some are non-selective (common)
  const messageTemplates = [
    // Common/non-selective patterns
    (rng, svc) => `Request processed successfully in ${Math.floor(rng() * 500)}ms`,
    (rng, svc) => `Connection established to ${svc} endpoint`,
    (rng, svc) => `Health check passed for ${svc}`,
    (rng, svc) => `Cache hit for key user_${Math.floor(rng() * 10000)}`,
    (rng, svc) => `Received request from client ${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}`,
    (rng, svc) => `Processing batch of ${Math.floor(rng() * 100) + 1} items`,
    (rng, svc) => `Database query completed in ${Math.floor(rng() * 200)}ms`,
    (rng, svc) => `Response sent with status ${[200, 200, 200, 201, 204, 301, 304][Math.floor(rng() * 7)]}`,
    (rng, svc) => `Middleware ${['auth', 'rate-limit', 'cors', 'logging'][Math.floor(rng() * 4)]} executed`,
    (rng, svc) => `Session validated for user_${Math.floor(rng() * 5000)}`,
    // Semi-selective patterns
    (rng, svc) => `Timeout waiting for ${svc} after ${Math.floor(rng() * 30) + 5}s`,
    (rng, svc) => `Rate limit exceeded for client ${Math.floor(rng() * 1000)}`,
    (rng, svc) => `Retry attempt ${Math.floor(rng() * 5) + 1} for operation on ${svc}`,
    (rng, svc) => `Memory usage at ${Math.floor(rng() * 40) + 60}% on ${svc}`,
    (rng, svc) => `Slow query detected: ${Math.floor(rng() * 5000) + 1000}ms on ${svc}`,
    // Selective/rare patterns
    (rng, svc) => `CRITICAL: Circuit breaker opened for ${svc}`,
    (rng, svc) => `FATAL: Unrecoverable error in ${svc} - stack overflow detected`,
    (rng, svc) => `SECURITY: Suspicious authentication pattern from IP 10.${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}`,
    (rng, svc) => `DEPLOYMENT: Rolling update started for ${svc} v${Math.floor(rng() * 10)}.${Math.floor(rng() * 20)}.${Math.floor(rng() * 100)}`,
    (rng, svc) => `MIGRATION: Schema change applied to ${svc} database table_${Math.floor(rng() * 50)}`,
  ];

  // Generate all rows in memory first, then batch insert
  const baseTs = new Date('2025-01-01T00:00:00Z').getTime();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  for (let batchStart = 0; batchStart < TOTAL; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL);
    const batchRows = batchEnd - batchStart;

    // Build a big VALUES clause
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (let i = batchStart; i < batchEnd; i++) {
      const ts = new Date(baseTs + Math.floor(rng() * thirtyDaysMs));
      const severity = severityBuckets[Math.floor(rng() * severityBuckets.length)];
      const service = services[Math.floor(rng() * services.length)];
      const templateIdx = Math.floor(rng() * messageTemplates.length);
      const message = messageTemplates[templateIdx](rng, service);

      values.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3})`);
      params.push(ts.toISOString(), severity, service, message);
      paramIdx += 4;
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`;
    await db.query(sql, params);

    if ((batchStart + BATCH_SIZE) % 10000 === 0 || batchEnd === TOTAL) {
      console.log(`  Seeded ${batchEnd} / ${TOTAL} rows`);
    }
  }
}

module.exports = { initDB };
