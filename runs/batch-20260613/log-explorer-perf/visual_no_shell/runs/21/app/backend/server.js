import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '..', 'pgdata');
const PORT = process.env.PORT || 3001;

const VALID_SEVERITIES = ['debug', 'info', 'warn', 'error'];
const MAX_LIMIT = 200;

let db;

// ── Deterministic PRNG (Mulberry32) ──
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Seed data generators ──
const SERVICES = [
  'api-gateway',
  'auth-service',
  'user-service',
  'payment-service',
  'notification-service',
  'search-service',
  'analytics-service',
  'storage-service',
];

const MESSAGE_TEMPLATES = [
  // debug (index 0-4)
  'Processing request payload size={size} bytes',
  'Cache lookup for key={key} completed in {dur}ms',
  'Database connection pool stats: active={active}, idle={idle}',
  'Serializing response object with {count} fields',
  'Retry attempt {attempt} for operation {op}',
  // info (index 5-9)
  'Request completed successfully in {dur}ms for endpoint {endpoint}',
  'User {user} logged in from {ip}',
  'Scheduled task {task} executed successfully',
  'Service health check passed with status {status}',
  'Configuration reloaded: {count} parameters updated',
  // warn (index 10-14)
  'High memory usage detected: {pct}% of available heap',
  'Slow query detected: {query} took {dur}ms',
  'Rate limit approaching for client {client}: {rate}/s',
  'Deprecated API version {version} called by {caller}',
  'Connection timeout after {dur}ms to {target}',
  // error (index 15-19)
  'Failed to process request: {error}',
  'Database connection lost: retrying in {dur}ms',
  'Unhandled exception in worker thread {thread}: {error}',
  'Authentication failed for user {user}: {reason}',
  'Disk space critical: {pct}% used on volume {volume}',
];

const FILL_VALUES = {
  size: ['128', '256', '512', '1024', '2048', '4096', '8192'],
  key: ['user:1001', 'session:abc123', 'cache:products', 'config:main', 'token:xyz789'],
  dur: ['2', '5', '12', '45', '120', '350', '1500', '3200'],
  active: ['3', '5', '8', '12', '20'],
  idle: ['2', '5', '10', '15'],
  count: ['3', '7', '12', '24', '48'],
  attempt: ['1', '2', '3', '4', '5'],
  op: ['fetchUser', 'saveOrder', 'sendEmail', 'syncData', 'generateReport'],
  endpoint: ['/api/users', '/api/orders', '/api/products', '/api/search', '/api/health'],
  user: ['alice', 'bob', 'charlie', 'diana', 'eve', 'frank'],
  ip: ['192.168.1.100', '10.0.0.42', '172.16.0.5', '203.0.113.7'],
  task: ['cleanup', 'backup', 'indexRebuild', 'metricsFlush', 'sessionPurge'],
  status: ['healthy', 'degraded', 'recovering'],
  pct: ['75', '82', '88', '91', '95', '98'],
  query: ['SELECT * FROM orders', 'UPDATE users SET', 'JOIN analytics ON', 'INSERT INTO logs'],
  client: ['mobile-app', 'web-frontend', 'partner-api', 'internal-cron'],
  rate: ['450', '780', '950', '1200'],
  version: ['v1', 'v2-beta', 'v3-alpha'],
  caller: ['legacy-client', 'mobile-v1', 'partner-sdk'],
  target: ['redis-primary', 'postgres-replica', 'elasticsearch', 's3-bucket'],
  error: [
    'NullPointerException',
    'ConnectionRefused',
    'TimeoutError',
    'OutOfMemoryError',
    'PermissionDenied',
  ],
  thread: ['worker-1', 'worker-2', 'worker-3', 'worker-4'],
  reason: ['invalid_token', 'expired_session', 'ip_blocked', 'brute_force_detected'],
  volume: ['/dev/sda1', '/dev/sdb1', '/mnt/data'],
};

function fillTemplate(template, rng) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const values = FILL_VALUES[key];
    if (!values) return `{${key}}`;
    return values[Math.floor(rng() * values.length)];
  });
}

function generateLogEntry(index, rng) {
  // Severity distribution: debug 60%, info 25%, warn 10%, error 5%
  const r = rng();
  let severity, templateStart, templateEnd;
  if (r < 0.6) {
    severity = 'debug';
    templateStart = 0;
    templateEnd = 5;
  } else if (r < 0.85) {
    severity = 'info';
    templateStart = 5;
    templateEnd = 10;
  } else if (r < 0.95) {
    severity = 'warn';
    templateStart = 10;
    templateEnd = 15;
  } else {
    severity = 'error';
    templateStart = 15;
    templateEnd = 20;
  }

  const templateIdx = templateStart + Math.floor(rng() * (templateEnd - templateStart));
  const message = fillTemplate(MESSAGE_TEMPLATES[templateIdx], rng);

  const service = SERVICES[Math.floor(rng() * SERVICES.length)];

  // Timestamps spanning 30 days, evenly distributed with jitter
  const baseTime = new Date('2025-01-01T00:00:00Z').getTime();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  const step = thirtyDays / 100000;
  const jitter = (rng() - 0.5) * step * 0.8;
  const ts = new Date(baseTime + index * step + jitter);

  return { ts, severity, service, message };
}

// ── Database initialization ──
async function initDb() {
  console.log('Initializing PGlite database...');
  const startBoot = Date.now();

  db = new PGlite(DATA_DIR);

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
    console.log(`Database already seeded with ${existingCount} rows. Skipping seed.`);
  } else {
    if (existingCount > 0) {
      console.log(`Found ${existingCount} rows (incomplete). Clearing and reseeding...`);
      await db.exec('TRUNCATE logs RESTART IDENTITY');
    }

    console.log('Seeding 100,000 log entries...');
    const seedStart = Date.now();
    const rng = mulberry32(42);

    // Generate all entries first
    const entries = [];
    for (let i = 0; i < 100000; i++) {
      entries.push(generateLogEntry(i, rng));
    }

    // Batch insert - 1000 rows per batch
    const BATCH_SIZE = 1000;
    for (let batchStart = 0; batchStart < entries.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, entries.length);
      const values = [];
      const params = [];
      let paramIdx = 1;

      for (let i = batchStart; i < batchEnd; i++) {
        const e = entries[i];
        values.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3})`);
        params.push(e.ts.toISOString(), e.severity, e.service, e.message);
        paramIdx += 4;
      }

      await db.query(
        `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`,
        params
      );

      if ((batchStart / BATCH_SIZE) % 10 === 0) {
        console.log(`  Seeded ${batchEnd} / 100,000 rows...`);
      }
    }

    console.log(`Seeding completed in ${Date.now() - seedStart}ms`);
  }

  // Create indexes (IF NOT EXISTS to be idempotent)
  console.log('Ensuring indexes...');
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING btree (lower(message) text_pattern_ops);
  `);

  // Try to create a pg_trgm index for substring search if available
  // PGlite may not support pg_trgm, so we do a fallback
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_logs_message_gin ON logs USING gin (lower(message) gin_trgm_ops)`
    );
    console.log('pg_trgm index created successfully');
  } catch (e) {
    console.log('pg_trgm not available, using fallback text search strategy');
  }

  console.log(`Database ready in ${Date.now() - startBoot}ms`);
}

// ── Express app ──
const app = express();
app.use(cors());
app.use(express.json());

// GET /api/logs
app.get('/api/logs', async (req, res) => {
  try {
    let { offset, limit, severity, q } = req.query;

    // Parse and validate offset
    offset = offset !== undefined ? parseInt(offset, 10) : 0;
    if (isNaN(offset) || offset < 0) {
      return res.status(400).json({ error: 'Invalid offset: must be a non-negative integer' });
    }

    // Parse and validate limit
    limit = limit !== undefined ? parseInt(limit, 10) : 50;
    if (isNaN(limit) || limit < 1 || limit > MAX_LIMIT) {
      return res.status(400).json({
        error: `Invalid limit: must be between 1 and ${MAX_LIMIT}`,
      });
    }

    // Validate severity
    if (severity !== undefined && severity !== '') {
      if (!VALID_SEVERITIES.includes(severity)) {
        return res.status(400).json({
          error: `Invalid severity: must be one of ${VALID_SEVERITIES.join(', ')}`,
        });
      }
    }

    // Build query
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (severity && severity !== '') {
      conditions.push(`severity = $${paramIdx}`);
      params.push(severity);
      paramIdx++;
    }

    if (q && q.trim() !== '') {
      conditions.push(`message ILIKE $${paramIdx}`);
      params.push(`%${q.trim()}%`);
      paramIdx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countQuery = `SELECT COUNT(*)::int AS total FROM logs ${whereClause}`;
    const countResult = await db.query(countQuery, params);
    const total = countResult.rows[0].total;

    // Get rows
    const dataQuery = `SELECT id, ts, severity, service, message FROM logs ${whereClause} ORDER BY ts DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
    const dataParams = [...params, limit, offset];
    const dataResult = await db.query(dataQuery, dataParams);

    res.json({
      total,
      rows: dataResult.rows,
    });
  } catch (err) {
    console.error('Query error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/stats
app.get('/api/stats', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE severity = 'debug')::int AS debug,
        COUNT(*) FILTER (WHERE severity = 'info')::int AS info,
        COUNT(*) FILTER (WHERE severity = 'warn')::int AS warn,
        COUNT(*) FILTER (WHERE severity = 'error')::int AS error
      FROM logs
    `);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ── Start ──
async function main() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Backend server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
