// Deterministic seed for 100,000 log entries
// Uses a simple seeded PRNG for reproducibility

const TOTAL_ROWS = 100_000;
const BATCH_SIZE = 500; // Conservative batch size for PGLite

// Simple mulberry32 PRNG
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SERVICES = [
  'api-gateway',
  'auth-service',
  'user-service',
  'payment-service',
  'notification-service',
  'search-service',
  'analytics-service',
  'cdn-proxy',
];

// Distribution: debug 60%, info 25%, warn 10%, error 5%
const SEVERITY_WEIGHTS = [
  { severity: 'debug', weight: 60 },
  { severity: 'info', weight: 25 },
  { severity: 'warn', weight: 10 },
  { severity: 'error', weight: 5 },
];

const SEVERITY_CUMULATIVE = [];
{
  let cum = 0;
  for (const s of SEVERITY_WEIGHTS) {
    cum += s.weight;
    SEVERITY_CUMULATIVE.push({ severity: s.severity, threshold: cum / 100 });
  }
}

function pickSeverity(rand) {
  const r = rand();
  for (const s of SEVERITY_CUMULATIVE) {
    if (r < s.threshold) return s.severity;
  }
  return 'error';
}

// Message templates with variable fragments
// Some terms are selective (rare), some are non-selective (common)
const MESSAGE_TEMPLATES = [
  // Non-selective: "request", "response", "user", "completed", "started"
  (rand, service) => {
    const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
    const paths = ['/api/users', '/api/orders', '/api/products', '/api/auth/login', '/api/search', '/api/payments', '/api/notifications', '/api/health'];
    const statuses = [200, 201, 204, 301, 400, 401, 403, 404, 500, 502, 503];
    const method = methods[Math.floor(rand() * methods.length)];
    const p = paths[Math.floor(rand() * paths.length)];
    const status = statuses[Math.floor(rand() * statuses.length)];
    const ms = Math.floor(rand() * 2000);
    return `${method} ${p} completed with status ${status} in ${ms}ms`;
  },
  (rand, service) => {
    const actions = ['created', 'updated', 'deleted', 'fetched', 'validated'];
    const resources = ['user profile', 'session token', 'order record', 'payment intent', 'search index'];
    const action = actions[Math.floor(rand() * actions.length)];
    const resource = resources[Math.floor(rand() * resources.length)];
    const id = Math.floor(rand() * 100000);
    return `Successfully ${action} ${resource} for entity id=${id}`;
  },
  (rand, service) => {
    const ms = Math.floor(rand() * 5000);
    const queries = ['SELECT * FROM users', 'INSERT INTO orders', 'UPDATE payments SET', 'DELETE FROM sessions', 'SELECT count(*) FROM logs'];
    const query = queries[Math.floor(rand() * queries.length)];
    return `Database query executed: "${query}" took ${ms}ms`;
  },
  (rand, service) => {
    const levels = ['nominal', 'degraded', 'critical'];
    const level = levels[Math.floor(rand() * levels.length)];
    const cpu = Math.floor(rand() * 100);
    const mem = Math.floor(rand() * 100);
    return `Health check ${level}: cpu=${cpu}% memory=${mem}% service=${service}`;
  },
  // Selective terms: "circuit breaker", "timeout", "deadlock", "overflow", "segfault"
  (rand, service) => {
    const issues = ['circuit breaker tripped', 'connection timeout detected', 'deadlock encountered in transaction', 'buffer overflow prevented', 'unexpected segfault in worker'];
    const issue = issues[Math.floor(rand() * issues.length)];
    const retry = Math.floor(rand() * 5) + 1;
    return `Critical: ${issue} on ${service}, retry attempt ${retry}`;
  },
  (rand, service) => {
    const cacheOps = ['cache hit', 'cache miss', 'cache eviction', 'cache invalidation'];
    const op = cacheOps[Math.floor(rand() * cacheOps.length)];
    const key = `key_${Math.floor(rand() * 10000)}`;
    return `${op} for ${key} in ${service} cache layer`;
  },
  (rand, service) => {
    const queueNames = ['email-queue', 'webhook-queue', 'analytics-queue', 'export-queue'];
    const queue = queueNames[Math.floor(rand() * queueNames.length)];
    const depth = Math.floor(rand() * 10000);
    return `Queue ${queue} depth=${depth}, processing rate stable on ${service}`;
  },
  (rand, service) => {
    const users = ['alice@example.com', 'bob@test.org', 'admin@internal', 'system@cron'];
    const user = users[Math.floor(rand() * users.length)];
    const actions = ['logged in', 'logged out', 'changed password', 'requested MFA token', 'failed authentication'];
    const a = actions[Math.floor(rand() * actions.length)];
    return `User ${user} ${a} via ${service}`;
  },
];

function generateMessage(rand, service) {
  const template = MESSAGE_TEMPLATES[Math.floor(rand() * MESSAGE_TEMPLATES.length)];
  return template(rand, service);
}

// Escape a string for SQL literal embedding (single-quote escaping)
function escapeSql(str) {
  return str.replace(/'/g, "''");
}

export async function seedDatabase(db) {
  // Check if already seeded
  const tableCheck = await db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_name = 'logs'
    ) AS exists
  `);

  const tableExists = tableCheck.rows[0]?.exists;

  if (tableExists) {
    const countResult = await db.query('SELECT count(*)::int AS cnt FROM logs');
    const count = countResult.rows[0]?.cnt || 0;
    if (count >= TOTAL_ROWS) {
      console.log(`Database already seeded with ${count} rows, skipping.`);
      return false; // No seeding performed
    }
    // Partial seed — drop and recreate
    console.log(`Found partial seed (${count} rows), reseeding...`);
    await db.query('DROP TABLE IF EXISTS logs');
  }

  console.log('Creating logs table...');
  await db.query(`
    CREATE TABLE logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL
    )
  `);

  console.log(`Seeding ${TOTAL_ROWS} log entries in batches of ${BATCH_SIZE}...`);
  const rand = mulberry32(42); // Fixed seed for determinism

  // Time range: 30 days ending at a fixed point (deterministic)
  const END_TS = new Date('2025-01-15T00:00:00Z').getTime();
  const START_TS = END_TS - 30 * 24 * 60 * 60 * 1000;

  // Generate all timestamps and sort for natural ordering
  const timestamps = [];
  for (let i = 0; i < TOTAL_ROWS; i++) {
    const ts = new Date(START_TS + rand() * (END_TS - START_TS));
    timestamps.push(ts);
  }
  timestamps.sort((a, b) => a.getTime() - b.getTime());

  // Re-initialize rand for other fields
  const rand2 = mulberry32(12345);

  const seedStart = Date.now();
  let inserted = 0;

  while (inserted < TOTAL_ROWS) {
    const batchEnd = Math.min(inserted + BATCH_SIZE, TOTAL_ROWS);

    // Build batch INSERT with inline values (faster than parameterized for large batches)
    const valueStrings = [];

    for (let i = inserted; i < batchEnd; i++) {
      const ts = timestamps[i].toISOString();
      const severity = pickSeverity(rand2);
      const service = SERVICES[Math.floor(rand2() * SERVICES.length)];
      const message = generateMessage(rand2, service);

      valueStrings.push(
        `('${ts}', '${severity}', '${escapeSql(service)}', '${escapeSql(message)}')`
      );
    }

    await db.query(
      `INSERT INTO logs (ts, severity, service, message) VALUES ${valueStrings.join(',\n')}`
    );

    inserted = batchEnd;
    if (inserted % 10000 === 0 || inserted === TOTAL_ROWS) {
      const elapsed = ((Date.now() - seedStart) / 1000).toFixed(1);
      console.log(`  Seeded ${inserted} / ${TOTAL_ROWS} rows (${elapsed}s)`);
    }
  }

  console.log('Creating indexes...');

  // Index for ordering by timestamp descending (most common query pattern)
  await db.query('CREATE INDEX idx_logs_ts_desc ON logs (ts DESC)');

  // Composite index for severity filter + timestamp ordering
  await db.query('CREATE INDEX idx_logs_severity_ts ON logs (severity, ts DESC)');

  // Try to create pg_trgm extension for efficient ILIKE substring search
  let hasTrgm = false;
  try {
    await db.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await db.query('CREATE INDEX idx_logs_message_trgm ON logs USING gin (lower(message) gin_trgm_ops)');
    hasTrgm = true;
    console.log('Created trigram index for substring search.');
  } catch (e) {
    console.log('pg_trgm not available, substring search will use sequential scan with index-assisted ordering.');
  }

  // ANALYZE to update statistics for the query planner
  await db.query('ANALYZE logs');

  const totalTime = ((Date.now() - seedStart) / 1000).toFixed(1);
  console.log(`Seeding complete in ${totalTime}s. Trigram index: ${hasTrgm}`);
  return true;
}
