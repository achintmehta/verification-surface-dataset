const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'pgdata');

let db = null;

async function getDb() {
  if (db) return db;
  db = new PGlite(DB_PATH);
  await db.waitReady;
  return db;
}

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

const SERVICES = [
  'api-gateway',
  'auth-service',
  'user-service',
  'payment-service',
  'notification-service',
  'search-service',
  'inventory-service',
  'analytics-service',
];

// Severity distribution: debug ~60%, info ~25%, warn ~10%, error ~5%
const SEVERITY_THRESHOLDS = [
  { threshold: 0.6, severity: 'debug' },
  { threshold: 0.85, severity: 'info' },
  { threshold: 0.95, severity: 'warn' },
  { threshold: 1.0, severity: 'error' },
];

// Message templates with variable fragments for diverse substring content
const MESSAGE_TEMPLATES = [
  'Processing request from client {client} with payload size {size} bytes',
  'Database query completed in {duration}ms for table {table}',
  'Cache {cacheAction} for key {cacheKey}',
  'Connection established from {ip} on port {port}',
  'User {userId} performed {action} on resource {resource}',
  'Health check passed with latency {latency}ms',
  'Rate limiter triggered for endpoint {endpoint} from {ip}',
  'Retry attempt {attempt} for operation {operation}',
  'Configuration reloaded: {configKey} updated to {configValue}',
  'Memory usage at {memPercent}% - {memStatus}',
  'Deployment artifact {artifact} validated successfully',
  'Authentication token {tokenAction} for session {sessionId}',
  'Webhook delivery to {webhookUrl} returned status {httpStatus}',
  'Background job {jobName} completed in {duration}ms',
  'File upload {fileName} ({size} bytes) stored in {bucket}',
  'Search query "{searchTerm}" returned {resultCount} results in {duration}ms',
  'SSL certificate for {domain} expires in {daysLeft} days',
  'Circuit breaker {cbState} for downstream service {downstream}',
  'Batch processing: {batchProcessed} of {batchTotal} items completed',
  'API version {apiVersion} deprecated - migrating to {newVersion}',
];

const CLIENTS = ['mobile-ios', 'mobile-android', 'web-chrome', 'web-firefox', 'cli-tool', 'sdk-python', 'sdk-java', 'partner-api'];
const TABLES = ['users', 'orders', 'products', 'sessions', 'events', 'logs', 'metrics', 'configs'];
const CACHE_ACTIONS = ['hit', 'miss', 'eviction', 'invalidation'];
const CACHE_KEYS = ['user:profile:', 'session:token:', 'product:detail:', 'rate:limit:', 'config:feature:'];
const ACTIONS = ['create', 'read', 'update', 'delete', 'export', 'import', 'archive'];
const RESOURCES = ['document', 'report', 'dashboard', 'integration', 'webhook', 'pipeline'];
const ENDPOINTS = ['/api/users', '/api/orders', '/api/search', '/api/upload', '/api/auth', '/api/metrics'];
const OPERATIONS = ['send_email', 'process_payment', 'sync_inventory', 'generate_report', 'index_document'];
const CONFIG_KEYS = ['max_connections', 'timeout_ms', 'feature_flag_v2', 'cache_ttl', 'log_level'];
const JOB_NAMES = ['cleanup_expired_sessions', 'aggregate_metrics', 'send_digest_emails', 'sync_external_data', 'optimize_indexes'];
const SEARCH_TERMS = ['authentication failure', 'connection timeout', 'invalid request', 'user login', 'payment processed'];
const DOMAINS = ['api.example.com', 'auth.example.com', 'cdn.example.com', 'ws.example.com'];
const DOWNSTREAM = ['redis-cluster', 'postgres-primary', 'elasticsearch', 'rabbitmq', 'external-api'];
const CB_STATES = ['opened', 'closed', 'half-open'];
const TOKEN_ACTIONS = ['issued', 'refreshed', 'revoked', 'expired'];
const MEM_STATUSES = ['within normal range', 'elevated but stable', 'approaching threshold', 'critical level reached'];
const BUCKETS = ['uploads-prod', 'uploads-staging', 'assets-cdn', 'backups-daily'];
const FILE_NAMES = ['report.pdf', 'data-export.csv', 'avatar.png', 'config.yaml', 'backup.sql.gz'];
const API_VERSIONS = ['v1', 'v2', 'v3'];

function pickFrom(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function generateMessage(rng, templateIndex) {
  const template = MESSAGE_TEMPLATES[templateIndex % MESSAGE_TEMPLATES.length];
  return template
    .replace('{client}', pickFrom(rng, CLIENTS))
    .replace('{size}', String(Math.floor(rng() * 50000) + 100))
    .replace('{duration}', String(Math.floor(rng() * 5000) + 1))
    .replace('{table}', pickFrom(rng, TABLES))
    .replace('{cacheAction}', pickFrom(rng, CACHE_ACTIONS))
    .replace('{cacheKey}', pickFrom(rng, CACHE_KEYS) + Math.floor(rng() * 10000))
    .replace('{ip}', `${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}`)
    .replace('{port}', String(Math.floor(rng() * 60000) + 1024))
    .replace('{userId}', `usr_${Math.floor(rng() * 100000)}`)
    .replace('{action}', pickFrom(rng, ACTIONS))
    .replace('{resource}', pickFrom(rng, RESOURCES))
    .replace('{latency}', String(Math.floor(rng() * 200) + 1))
    .replace('{endpoint}', pickFrom(rng, ENDPOINTS))
    .replace('{attempt}', String(Math.floor(rng() * 5) + 1))
    .replace('{operation}', pickFrom(rng, OPERATIONS))
    .replace('{configKey}', pickFrom(rng, CONFIG_KEYS))
    .replace('{configValue}', String(Math.floor(rng() * 1000)))
    .replace('{memPercent}', String(Math.floor(rng() * 100)))
    .replace('{memStatus}', pickFrom(rng, MEM_STATUSES))
    .replace('{artifact}', `build-${Math.floor(rng() * 9000) + 1000}`)
    .replace('{tokenAction}', pickFrom(rng, TOKEN_ACTIONS))
    .replace('{sessionId}', `sess_${Math.floor(rng() * 1000000)}`)
    .replace('{webhookUrl}', `https://hooks.example.com/${Math.floor(rng() * 1000)}`)
    .replace('{httpStatus}', String(pickFrom(rng, [200, 201, 400, 401, 403, 404, 500, 502, 503])))
    .replace('{jobName}', pickFrom(rng, JOB_NAMES))
    .replace('{fileName}', pickFrom(rng, FILE_NAMES))
    .replace('{bucket}', pickFrom(rng, BUCKETS))
    .replace('{searchTerm}', pickFrom(rng, SEARCH_TERMS))
    .replace('{resultCount}', String(Math.floor(rng() * 10000)))
    .replace('{domain}', pickFrom(rng, DOMAINS))
    .replace('{daysLeft}', String(Math.floor(rng() * 365) + 1))
    .replace('{cbState}', pickFrom(rng, CB_STATES))
    .replace('{downstream}', pickFrom(rng, DOWNSTREAM))
    .replace('{batchProcessed}', String(Math.floor(rng() * 1000)))
    .replace('{batchTotal}', String(Math.floor(rng() * 1000) + 1000))
    .replace('{apiVersion}', pickFrom(rng, API_VERSIONS))
    .replace('{newVersion}', pickFrom(rng, API_VERSIONS));
}

const TOTAL_ROWS = 100000;
const BATCH_SIZE = 2000;
// 30 days span in milliseconds
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const BASE_TS = new Date('2025-01-01T00:00:00Z').getTime();

async function createSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL,
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);
}

async function createIndexes(db) {
  // Index for ordering by ts (descending queries)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);`);
  // Composite index for severity filtering + ts ordering
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);`);
  // pg_trgm is not available in PGLite, so we use a btree index on lower(message)
  // For substring search, we rely on sequential scan with the indexes helping for severity combo
  // We'll optimize substring search with a different strategy if needed
}

async function needsSeeding(db) {
  try {
    const result = await db.query('SELECT COUNT(*)::int AS cnt FROM logs');
    const count = result.rows[0].cnt;
    return count < TOTAL_ROWS;
  } catch (e) {
    // Table doesn't exist yet
    return true;
  }
}

async function seed(db) {
  const rng = mulberry32(42); // deterministic seed

  console.log(`Seeding ${TOTAL_ROWS} log entries...`);
  const startTime = Date.now();

  for (let batch = 0; batch < TOTAL_ROWS; batch += BATCH_SIZE) {
    const batchEnd = Math.min(batch + BATCH_SIZE, TOTAL_ROWS);
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (let i = batch; i < batchEnd; i++) {
      // Deterministic timestamp spread over 30 days
      const tsOffset = Math.floor(rng() * THIRTY_DAYS_MS);
      const ts = new Date(BASE_TS + tsOffset);

      // Severity distribution
      const sevRoll = rng();
      let severity = 'debug';
      for (const st of SEVERITY_THRESHOLDS) {
        if (sevRoll < st.threshold) {
          severity = st.severity;
          break;
        }
      }

      const service = pickFrom(rng, SERVICES);
      const templateIndex = Math.floor(rng() * MESSAGE_TEMPLATES.length);
      const message = generateMessage(rng, templateIndex);

      values.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3})`);
      params.push(ts.toISOString(), severity, service, message);
      paramIdx += 4;
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`;
    await db.query(sql, params);

    const progress = Math.round((batchEnd / TOTAL_ROWS) * 100);
    if (progress % 10 === 0 || batchEnd === TOTAL_ROWS) {
      console.log(`  Seeded ${batchEnd}/${TOTAL_ROWS} rows (${progress}%)`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Seeding complete in ${elapsed}s`);
}

async function initDb() {
  const db = await getDb();
  await createSchema(db);

  if (await needsSeeding(db)) {
    await seed(db);
    console.log('Creating indexes...');
    await createIndexes(db);
    // Analyze for query planner
    await db.exec('ANALYZE logs;');
    console.log('Indexes created and analyzed.');
  } else {
    console.log('Database already seeded, skipping.');
  }

  return db;
}

module.exports = { initDb, getDb };
