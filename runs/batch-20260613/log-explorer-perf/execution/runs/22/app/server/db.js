const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'pgdata');
const TOTAL_ROWS = 100000;
const BATCH_SIZE = 2000;

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

// Severity distribution: ~60% debug, ~25% info, ~10% warn, ~5% error
const SEVERITY_THRESHOLDS = [
  { threshold: 0.60, value: 'debug' },
  { threshold: 0.85, value: 'info' },
  { threshold: 0.95, value: 'warn' },
  { threshold: 1.00, value: 'error' },
];

function pickSeverity(rand) {
  for (const { threshold, value } of SEVERITY_THRESHOLDS) {
    if (rand < threshold) return value;
  }
  return 'error';
}

const MESSAGE_TEMPLATES = [
  'Request processed successfully in {duration}ms',
  'Connection established to {host}:{port}',
  'Cache miss for key {cacheKey}',
  'Cache hit for key {cacheKey}',
  'User {userId} authenticated via {authMethod}',
  'Database query completed in {duration}ms, returned {rowCount} rows',
  'Rate limit exceeded for client {clientId}',
  'Health check passed: cpu={cpuPct}%, mem={memPct}%',
  'Retry attempt {attempt} of {maxAttempts} for operation {operation}',
  'Configuration reloaded from {configSource}',
  'Timeout waiting for response from {host} after {duration}ms',
  'Failed to connect to {host}:{port}: connection refused',
  'Invalid request payload: missing required field {fieldName}',
  'Outbound webhook delivered to {webhookUrl} in {duration}ms',
  'Scheduled task {taskName} started',
  'Scheduled task {taskName} completed in {duration}ms',
  'Memory usage warning: heap at {memPct}%',
  'Disk usage at {diskPct}% on volume {volumeName}',
  'SSL certificate for {host} expires in {dayCount} days',
  'Deployment {deployId} rolled out to {instanceCount} instances',
];

const VARIABLE_POOLS = {
  duration: ['12', '45', '120', '250', '500', '1024', '3500', '8000'],
  host: ['db-primary.internal', 'cache-01.internal', 'queue.internal', 'storage.internal', 'partner-api.example.com'],
  port: ['5432', '6379', '8080', '443', '9200'],
  cacheKey: ['user:1001:profile', 'session:abc123', 'config:feature-flags', 'product:sku-9876', 'rate:client-42'],
  userId: ['usr_1001', 'usr_2045', 'usr_3399', 'usr_5500', 'usr_7812', 'usr_9100'],
  authMethod: ['oauth2', 'api-key', 'jwt', 'basic', 'saml'],
  clientId: ['client-42', 'client-108', 'client-256', 'client-999'],
  rowCount: ['0', '1', '15', '128', '500', '2048'],
  cpuPct: ['12', '34', '56', '78', '92'],
  memPct: ['45', '62', '78', '88', '95'],
  attempt: ['1', '2', '3'],
  maxAttempts: ['3', '5'],
  operation: ['sendEmail', 'processPayment', 'syncInventory', 'generateReport'],
  configSource: ['consul', 'vault', 'env', 'config.yaml'],
  fieldName: ['email', 'orderId', 'amount', 'timestamp', 'correlationId'],
  webhookUrl: ['https://hooks.example.com/notify', 'https://integrations.partner.io/events'],
  taskName: ['cleanupExpiredSessions', 'aggregateMetrics', 'generateInvoices', 'syncCatalog'],
  diskPct: ['70', '82', '91', '96'],
  volumeName: ['/data', '/logs', '/tmp', '/backups'],
  dayCount: ['3', '7', '14', '30', '90'],
  deployId: ['deploy-a1b2c3', 'deploy-d4e5f6', 'deploy-789abc'],
  instanceCount: ['2', '4', '8', '16'],
};

function generateMessage(rng) {
  const template = MESSAGE_TEMPLATES[Math.floor(rng() * MESSAGE_TEMPLATES.length)];
  return template.replace(/\{(\w+)\}/g, (_, varName) => {
    const pool = VARIABLE_POOLS[varName];
    if (!pool) return varName;
    return pool[Math.floor(rng() * pool.length)];
  });
}

async function initDatabase() {
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

  if (existingCount >= TOTAL_ROWS) {
    console.log(`Database already seeded with ${existingCount} rows, skipping seed.`);

    // Ensure indexes exist (idempotent)
    await ensureIndexes(db);
    return db;
  }

  if (existingCount > 0 && existingCount < TOTAL_ROWS) {
    console.log(`Partial seed detected (${existingCount} rows), clearing and reseeding...`);
    await db.exec('DELETE FROM logs');
  }

  console.log(`Seeding ${TOTAL_ROWS} log entries...`);
  const seedStart = Date.now();

  const rng = mulberry32(42); // deterministic seed

  // 30-day range ending at a fixed point
  const endTs = new Date('2025-06-01T00:00:00Z').getTime();
  const startTs = endTs - 30 * 24 * 60 * 60 * 1000;
  const range = endTs - startTs;

  // Generate all timestamps first for ordering
  const entries = [];
  for (let i = 0; i < TOTAL_ROWS; i++) {
    const ts = new Date(startTs + rng() * range);
    const severity = pickSeverity(rng());
    const service = SERVICES[Math.floor(rng() * SERVICES.length)];
    const message = generateMessage(rng);
    entries.push({ ts, severity, service, message });
  }

  // Sort by timestamp ascending so ids align with time order
  entries.sort((a, b) => a.ts - b.ts);

  // Batch insert
  for (let i = 0; i < TOTAL_ROWS; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (const entry of batch) {
      values.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3})`);
      params.push(entry.ts.toISOString(), entry.severity, entry.service, entry.message);
      paramIdx += 4;
    }

    await db.query(
      `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`,
      params
    );

    if ((i + BATCH_SIZE) % 20000 === 0 || i + BATCH_SIZE >= TOTAL_ROWS) {
      console.log(`  Inserted ${Math.min(i + BATCH_SIZE, TOTAL_ROWS)} / ${TOTAL_ROWS}`);
    }
  }

  const seedElapsed = ((Date.now() - seedStart) / 1000).toFixed(1);
  console.log(`Seeding complete in ${seedElapsed}s`);

  await ensureIndexes(db);

  return db;
}

async function ensureIndexes(db) {
  console.log('Ensuring indexes...');
  const indexStart = Date.now();

  // Index for ordering by ts desc (default query)
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC)');

  // Composite index for severity filter + ts ordering
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC)');

  // Trigram index for substring search - PGLite may not support pg_trgm,
  // so we'll use a functional approach with LOWER + btree for prefix, 
  // and rely on good query planning for LIKE patterns.
  // For case-insensitive search, we create a functional index on lower(message).
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_message_lower ON logs (LOWER(message) text_pattern_ops)');

  const idxElapsed = ((Date.now() - indexStart) / 1000).toFixed(1);
  console.log(`Indexes ready in ${idxElapsed}s`);
}

module.exports = { initDatabase };
