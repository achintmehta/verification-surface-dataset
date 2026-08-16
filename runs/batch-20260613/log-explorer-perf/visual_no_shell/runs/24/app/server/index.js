import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '..', 'pgdata');
const PORT = 3001;
const MAX_LIMIT = 200;

const VALID_SEVERITIES = ['debug', 'info', 'warn', 'error'];

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

// Message templates with variable fragments
const MESSAGE_TEMPLATES = [
  'Request processed successfully in {duration}ms',
  'Connection established to {host}',
  'Failed to connect to {host}: timeout after {duration}ms',
  'User {userId} authenticated via {method}',
  'Cache miss for key {cacheKey}',
  'Cache hit for key {cacheKey}',
  'Database query completed in {duration}ms',
  'Rate limit exceeded for IP {ip}',
  'Health check passed: all systems operational',
  'Deployment started for version {version}',
  'Configuration reloaded from {source}',
  'Memory usage at {percent}%',
  'Disk usage at {percent}% on volume {volume}',
  'SSL certificate expires in {days} days',
  'Retry attempt {attempt} for operation {operation}',
  'Request timeout after {duration}ms for endpoint {endpoint}',
  'Invalid input received: {field} is required',
  'Background job {jobId} completed successfully',
  'Background job {jobId} failed with error: {errorMsg}',
  'Webhook delivery to {webhookUrl} succeeded',
  'Webhook delivery to {webhookUrl} failed: HTTP {statusCode}',
  'File uploaded: {filename} ({filesize}KB)',
  'Email sent to {email} via {provider}',
  'Payment processed: {amount} {currency}',
  'Order {orderId} status changed to {status}',
  'Inventory updated for product {productId}: {quantity} units',
  'Search query "{searchTerm}" returned {resultCount} results',
  'API key {apiKeyPrefix} used for {endpoint}',
  'Session expired for user {userId}',
  'New user registered: {email}'
];

const HOSTS = ['db-primary.internal', 'db-replica.internal', 'cache-01.internal', 'redis-cluster.internal', 'kafka-broker.internal'];
const METHODS = ['OAuth2', 'JWT', 'API-Key', 'SAML', 'Basic'];
const ENDPOINTS = ['/api/users', '/api/orders', '/api/products', '/api/search', '/api/payments', '/api/webhooks', '/api/health'];
const OPERATIONS = ['send_email', 'process_payment', 'sync_inventory', 'generate_report', 'backup_database'];
const ERROR_MSGS = ['connection refused', 'permission denied', 'resource not found', 'quota exceeded', 'invalid state'];
const SOURCES = ['consul', 'vault', 'env-file', 'config-server', 'etcd'];
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD'];
const STATUSES = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];
const PROVIDERS = ['sendgrid', 'ses', 'mailgun', 'postmark'];
const SEARCH_TERMS = ['wireless headphones', 'laptop stand', 'USB cable', 'monitor arm', 'keyboard'];
const VOLUMES = ['/dev/sda1', '/dev/sdb1', '/dev/nvme0n1', '/mnt/data'];
const FIELDS = ['email', 'name', 'address', 'phone', 'password'];

function generateMessage(rng, templateIdx) {
  const template = MESSAGE_TEMPLATES[templateIdx % MESSAGE_TEMPLATES.length];
  return template
    .replace('{duration}', String(Math.floor(rng() * 5000)))
    .replace('{host}', HOSTS[Math.floor(rng() * HOSTS.length)])
    .replace('{userId}', 'user-' + String(Math.floor(rng() * 10000)))
    .replace('{method}', METHODS[Math.floor(rng() * METHODS.length)])
    .replace('{cacheKey}', 'cache:' + ['session', 'product', 'config', 'rate'][Math.floor(rng() * 4)] + ':' + Math.floor(rng() * 1000))
    .replace('{ip}', `${Math.floor(rng() * 256)}.${Math.floor(rng() * 256)}.${Math.floor(rng() * 256)}.${Math.floor(rng() * 256)}`)
    .replace('{version}', `v${Math.floor(rng() * 10)}.${Math.floor(rng() * 20)}.${Math.floor(rng() * 100)}`)
    .replace('{source}', SOURCES[Math.floor(rng() * SOURCES.length)])
    .replace('{percent}', String(Math.floor(rng() * 100)))
    .replace('{volume}', VOLUMES[Math.floor(rng() * VOLUMES.length)])
    .replace('{days}', String(Math.floor(rng() * 365)))
    .replace('{attempt}', String(Math.floor(rng() * 5) + 1))
    .replace('{operation}', OPERATIONS[Math.floor(rng() * OPERATIONS.length)])
    .replace('{endpoint}', ENDPOINTS[Math.floor(rng() * ENDPOINTS.length)])
    .replace('{field}', FIELDS[Math.floor(rng() * FIELDS.length)])
    .replace('{jobId}', 'job-' + String(Math.floor(rng() * 100000)))
    .replace('{errorMsg}', ERROR_MSGS[Math.floor(rng() * ERROR_MSGS.length)])
    .replace('{webhookUrl}', 'https://hooks.example.com/' + ['stripe', 'github', 'slack', 'pagerduty'][Math.floor(rng() * 4)])
    .replace('{statusCode}', String([400, 401, 403, 404, 500, 502, 503][Math.floor(rng() * 7)]))
    .replace('{filename}', ['report', 'backup', 'export', 'avatar', 'document'][Math.floor(rng() * 5)] + '.pdf')
    .replace('{filesize}', String(Math.floor(rng() * 10000)))
    .replace('{email}', ['alice', 'bob', 'carol', 'dave', 'eve'][Math.floor(rng() * 5)] + '@example.com')
    .replace('{provider}', PROVIDERS[Math.floor(rng() * PROVIDERS.length)])
    .replace('{amount}', (Math.floor(rng() * 100000) / 100).toFixed(2))
    .replace('{currency}', CURRENCIES[Math.floor(rng() * CURRENCIES.length)])
    .replace('{orderId}', 'ORD-' + String(Math.floor(rng() * 1000000)).padStart(6, '0'))
    .replace('{status}', STATUSES[Math.floor(rng() * STATUSES.length)])
    .replace('{productId}', 'PROD-' + String(Math.floor(rng() * 10000)).padStart(4, '0'))
    .replace('{quantity}', String(Math.floor(rng() * 1000)))
    .replace('{searchTerm}', SEARCH_TERMS[Math.floor(rng() * SEARCH_TERMS.length)])
    .replace('{resultCount}', String(Math.floor(rng() * 10000)))
    .replace('{apiKeyPrefix}', 'sk_' + ['live', 'test'][Math.floor(rng() * 2)] + '_***')
    ;
}

async function initDatabase() {
  console.log('Initializing PGlite database...');
  const db = new PGlite(DATA_DIR);

  // Create table if not exists
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL,
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);

  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*)::int AS cnt FROM logs');
  const existingCount = countResult.rows[0].cnt;

  if (existingCount >= 100000) {
    console.log(`Database already seeded with ${existingCount} rows. Skipping seed.`);
    return db;
  }

  if (existingCount > 0 && existingCount < 100000) {
    console.log(`Partial seed detected (${existingCount} rows). Clearing and reseeding...`);
    await db.exec('DELETE FROM logs');
  }

  console.log('Seeding 100,000 log entries...');
  const seedStart = Date.now();

  const rng = mulberry32(42); // Deterministic seed

  // 30-day span ending now-ish. Use a fixed date for determinism.
  const END_TS = new Date('2025-06-10T00:00:00Z').getTime();
  const START_TS = END_TS - 30 * 24 * 60 * 60 * 1000;
  const TOTAL_ROWS = 100000;

  // Severity distribution: ~60% info, ~25% debug, ~10% warn, ~5% error
  // We'll use cumulative thresholds
  function pickSeverity(r) {
    if (r < 0.05) return 'error';
    if (r < 0.15) return 'warn';
    if (r < 0.40) return 'debug';
    return 'info';
  }

  // Batch insert for performance
  const BATCH_SIZE = 2000;
  const totalBatches = Math.ceil(TOTAL_ROWS / BATCH_SIZE);

  for (let batch = 0; batch < totalBatches; batch++) {
    const batchStart = batch * BATCH_SIZE;
    const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL_ROWS);
    const batchLen = batchEnd - batchStart;

    // Build a multi-row INSERT
    const values = [];
    const params = [];
    for (let i = 0; i < batchLen; i++) {
      const idx = batchStart + i;
      // Spread timestamps evenly with small jitter
      const baseTsMs = START_TS + (idx / TOTAL_ROWS) * (END_TS - START_TS);
      const jitter = (rng() - 0.5) * 60000; // +/- 30 seconds
      const ts = new Date(baseTsMs + jitter).toISOString();

      const severity = pickSeverity(rng());
      const service = SERVICES[Math.floor(rng() * SERVICES.length)];
      const templateIdx = Math.floor(rng() * MESSAGE_TEMPLATES.length);
      const message = generateMessage(rng, templateIdx);

      const offset = i * 4;
      values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`);
      params.push(ts, severity, service, message);
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`;
    await db.query(sql, params);

    if ((batch + 1) % 10 === 0 || batch === totalBatches - 1) {
      console.log(`  Seeded ${batchEnd} / ${TOTAL_ROWS} rows...`);
    }
  }

  console.log(`Seeding completed in ${((Date.now() - seedStart) / 1000).toFixed(1)}s`);

  // Create indexes
  console.log('Creating indexes...');
  const indexStart = Date.now();

  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC)');
  // For substring search, we'll use a pg_trgm-like approach or just rely on ILIKE with the index on ts for ordering
  // PGLite may not have pg_trgm, so we'll create a functional index for lower(message)
  // Actually for ILIKE substring, standard btree won't help. Let's just rely on seq scan for text search
  // but ordering by ts DESC via index. For 100k rows ILIKE is typically fast enough.
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_message_lower ON logs (lower(message) text_pattern_ops)');

  console.log(`Indexes created in ${((Date.now() - indexStart) / 1000).toFixed(1)}s`);

  return db;
}

async function main() {
  const bootStart = Date.now();
  const db = await initDatabase();
  console.log(`Database ready in ${((Date.now() - bootStart) / 1000).toFixed(1)}s`);

  const app = express();
  app.use(cors());
  app.use(express.json());

  // GET /api/logs?offset=&limit=&severity=&q=
  app.get('/api/logs', async (req, res) => {
    try {
      let offset = parseInt(req.query.offset, 10);
      let limit = parseInt(req.query.limit, 10);
      const severity = req.query.severity || null;
      const q = req.query.q || null;

      // Default values
      if (isNaN(offset)) offset = 0;
      if (isNaN(limit)) limit = 50;

      // Validation
      if (offset < 0) {
        return res.status(400).json({ error: 'offset must be non-negative' });
      }
      if (limit < 1 || limit > MAX_LIMIT) {
        return res.status(400).json({ error: `limit must be between 1 and ${MAX_LIMIT}` });
      }
      if (severity && !VALID_SEVERITIES.includes(severity)) {
        return res.status(400).json({ error: `severity must be one of: ${VALID_SEVERITIES.join(', ')}` });
      }

      // Build query
      const conditions = [];
      const params = [];
      let paramIdx = 1;

      if (severity) {
        conditions.push(`severity = $${paramIdx++}`);
        params.push(severity);
      }
      if (q) {
        conditions.push(`message ILIKE $${paramIdx++}`);
        params.push(`%${q}%`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Get total count
      const countSql = `SELECT COUNT(*)::int AS total FROM logs ${whereClause}`;
      const countResult = await db.query(countSql, params);
      const total = countResult.rows[0].total;

      // Get rows
      const dataSql = `SELECT id, ts, severity, service, message FROM logs ${whereClause} ORDER BY ts DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
      const dataParams = [...params, limit, offset];
      const dataResult = await db.query(dataSql, dataParams);

      res.json({
        total,
        rows: dataResult.rows
      });
    } catch (err) {
      console.error('Error querying logs:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/stats
  app.get('/api/stats', async (req, res) => {
    try {
      const totalResult = await db.query('SELECT COUNT(*)::int AS total FROM logs');
      const severityResult = await db.query(
        `SELECT severity, COUNT(*)::int AS count FROM logs GROUP BY severity ORDER BY severity`
      );

      const bySeverity = {};
      for (const row of severityResult.rows) {
        bySeverity[row.severity] = row.count;
      }

      res.json({
        total: totalResult.rows[0].total,
        bySeverity
      });
    } catch (err) {
      console.error('Error getting stats:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.listen(PORT, () => {
    const bootTime = ((Date.now() - bootStart) / 1000).toFixed(1);
    console.log(`Server listening on http://localhost:${PORT} (boot time: ${bootTime}s)`);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
