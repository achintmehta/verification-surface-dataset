import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_DIR = join(__dirname, 'data', 'pglite');
const PORT = process.env.PORT || 3001;

// ─── Deterministic PRNG (mulberry32) ────────────────────────────────────────
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Seed data constants ─────────────────────────────────────────────────────
const SERVICES = [
  'auth-service',
  'api-gateway',
  'user-service',
  'payment-service',
  'notification-service',
  'inventory-service',
  'search-service',
  'analytics-service',
];

const SEVERITIES = ['debug', 'info', 'warn', 'error'];
// Roughly 60/25/10/5 distribution
const SEVERITY_WEIGHTS = [0.60, 0.25, 0.10, 0.05];

const MESSAGE_TEMPLATES = [
  // debug templates (0-7)
  (r) => `Processing request ${r.reqId} for user ${r.userId}`,
  (r) => `Cache lookup for key ${r.cacheKey} returned ${r.hit ? 'HIT' : 'MISS'}`,
  (r) => `Database query executed in ${r.duration}ms: SELECT * FROM ${r.table}`,
  (r) => `Entering function ${r.funcName} with args count=${r.argCount}`,
  (r) => `Token validation completed for session ${r.sessionId}`,
  (r) => `Retry attempt ${r.attempt} of ${r.maxAttempts} for operation ${r.op}`,
  (r) => `Batch job ${r.jobId} processed ${r.count} items`,
  (r) => `Config loaded: feature_flag=${r.flag} value=${r.flagVal}`,
  // info templates (8-17)
  (r) => `User ${r.userId} logged in from IP ${r.ip}`,
  (r) => `Order ${r.orderId} created successfully for customer ${r.customerId}`,
  (r) => `Payment of $${r.amount} processed via ${r.method} for order ${r.orderId}`,
  (r) => `Email notification sent to ${r.email} for event ${r.event}`,
  (r) => `Service ${r.service} started on port ${r.port}`,
  (r) => `Health check passed for endpoint ${r.endpoint}`,
  (r) => `Inventory updated: product ${r.productId} stock=${r.stock}`,
  (r) => `Search query "${r.query}" returned ${r.resultCount} results in ${r.duration}ms`,
  (r) => `User ${r.userId} updated profile field ${r.field}`,
  (r) => `Scheduled task ${r.taskName} completed in ${r.duration}ms`,
  // warn templates (18-23)
  (r) => `Rate limit approaching for client ${r.clientId}: ${r.current}/${r.limit} requests`,
  (r) => `Slow query detected (${r.duration}ms): SELECT * FROM ${r.table} WHERE ${r.condition}`,
  (r) => `Memory usage at ${r.percent}% on instance ${r.instanceId}`,
  (r) => `Deprecated API endpoint ${r.endpoint} called by ${r.clientId}`,
  (r) => `Connection pool exhausted for database ${r.db}: waiting ${r.waitMs}ms`,
  (r) => `Retry ${r.attempt}/${r.maxAttempts} failed for service ${r.service}: ${r.reason}`,
  // error templates (24-28)
  (r) => `Failed to connect to database ${r.db} after ${r.attempts} attempts: ${r.error}`,
  (r) => `Unhandled exception in ${r.service}: ${r.error} at ${r.location}`,
  (r) => `Payment processing failed for order ${r.orderId}: ${r.error}`,
  (r) => `Authentication failed for user ${r.userId}: invalid credentials`,
  (r) => `Service ${r.service} is unavailable: circuit breaker OPEN`,
];

function pickSeverity(rand) {
  const r = rand();
  let cumulative = 0;
  for (let i = 0; i < SEVERITY_WEIGHTS.length; i++) {
    cumulative += SEVERITY_WEIGHTS[i];
    if (r < cumulative) return SEVERITIES[i];
  }
  return SEVERITIES[SEVERITIES.length - 1];
}

function generateRow(i, rand) {
  // Timestamps spanning 30 days, deterministically spread
  const START_TS = new Date('2024-01-01T00:00:00Z').getTime();
  const END_TS = new Date('2024-01-31T23:59:59Z').getTime();
  const ts = new Date(START_TS + Math.floor(rand() * (END_TS - START_TS)));

  const severity = pickSeverity(rand);
  const service = SERVICES[Math.floor(rand() * SERVICES.length)];

  // Variable fragments for selective/non-selective search
  const reqId = `req-${Math.floor(rand() * 1000000).toString(16).padStart(6, '0')}`;
  const userId = `usr-${Math.floor(rand() * 10000)}`;
  const orderId = `ord-${Math.floor(rand() * 100000)}`;
  const customerId = `cust-${Math.floor(rand() * 50000)}`;
  const sessionId = `sess-${Math.floor(rand() * 1000000).toString(16).padStart(8, '0')}`;
  const cacheKey = `cache:${['user', 'product', 'session', 'config'][Math.floor(rand() * 4)]}:${Math.floor(rand() * 10000)}`;
  const table = ['users', 'orders', 'products', 'sessions', 'events', 'logs'][Math.floor(rand() * 6)];
  const funcName = ['handleRequest', 'processPayment', 'validateToken', 'fetchUser', 'updateInventory'][Math.floor(rand() * 5)];
  const argCount = Math.floor(rand() * 5) + 1;
  const duration = Math.floor(rand() * 500) + 1;
  const attempt = Math.floor(rand() * 3) + 1;
  const maxAttempts = 3;
  const op = ['db-write', 'cache-set', 'api-call', 'file-upload'][Math.floor(rand() * 4)];
  const jobId = `job-${Math.floor(rand() * 10000)}`;
  const count = Math.floor(rand() * 1000) + 1;
  const flag = ['dark_mode', 'new_checkout', 'beta_search', 'v2_api'][Math.floor(rand() * 4)];
  const flagVal = rand() > 0.5 ? 'true' : 'false';
  const ip = `${Math.floor(rand() * 256)}.${Math.floor(rand() * 256)}.${Math.floor(rand() * 256)}.${Math.floor(rand() * 256)}`;
  const amount = (rand() * 1000).toFixed(2);
  const method = ['credit_card', 'paypal', 'stripe', 'bank_transfer'][Math.floor(rand() * 4)];
  const email = `user${Math.floor(rand() * 10000)}@example.com`;
  const event = ['signup', 'purchase', 'password_reset', 'subscription'][Math.floor(rand() * 4)];
  const port = [3000, 3001, 8080, 8443, 5432][Math.floor(rand() * 5)];
  const endpoint = ['/health', '/api/v1/users', '/api/v2/orders', '/metrics'][Math.floor(rand() * 4)];
  const productId = `prod-${Math.floor(rand() * 5000)}`;
  const stock = Math.floor(rand() * 1000);
  const query = ['laptop', 'phone', 'tablet', 'headphones', 'keyboard'][Math.floor(rand() * 5)];
  const resultCount = Math.floor(rand() * 500);
  const field = ['email', 'name', 'address', 'phone', 'preferences'][Math.floor(rand() * 5)];
  const taskName = ['cleanup', 'report-gen', 'cache-warm', 'index-rebuild'][Math.floor(rand() * 4)];
  const clientId = `client-${Math.floor(rand() * 1000)}`;
  const current = Math.floor(rand() * 100) + 80;
  const limit = 100;
  const percent = Math.floor(rand() * 30) + 70;
  const instanceId = `i-${Math.floor(rand() * 100000).toString(16).padStart(8, '0')}`;
  const condition = `id = ${Math.floor(rand() * 100000)}`;
  const db = ['primary', 'replica-1', 'replica-2', 'analytics'][Math.floor(rand() * 4)];
  const waitMs = Math.floor(rand() * 5000) + 100;
  const reason = ['timeout', 'connection refused', 'DNS failure', 'TLS error'][Math.floor(rand() * 4)];
  const attempts = Math.floor(rand() * 5) + 1;
  const error = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'SSL_ERROR', 'ENOMEM'][Math.floor(rand() * 5)];
  const location = `${funcName}:${Math.floor(rand() * 200) + 1}`;
  const hit = rand() > 0.3;

  const vars = {
    reqId, userId, orderId, customerId, sessionId, cacheKey, table, funcName,
    argCount, duration, attempt, maxAttempts, op, jobId, count, flag, flagVal,
    ip, amount, method, email, event, port, endpoint, productId, stock, query,
    resultCount, field, taskName, clientId, current, limit, percent, instanceId,
    condition, db, waitMs, reason, attempts, error, location, hit, service,
  };

  // Pick template based on severity
  let templatePool;
  if (severity === 'debug') templatePool = [0, 1, 2, 3, 4, 5, 6, 7];
  else if (severity === 'info') templatePool = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
  else if (severity === 'warn') templatePool = [18, 19, 20, 21, 22, 23];
  else templatePool = [24, 25, 26, 27, 28];

  const templateIdx = templatePool[Math.floor(rand() * templatePool.length)];
  const message = MESSAGE_TEMPLATES[templateIdx](vars);

  return { ts: ts.toISOString(), severity, service, message };
}

// ─── Database initialization ─────────────────────────────────────────────────
async function initDatabase() {
  if (!existsSync(join(__dirname, 'data'))) {
    mkdirSync(join(__dirname, 'data'), { recursive: true });
  }

  console.log('Initializing PGLite database...');
  const db = new PGlite(DB_DIR);

  // Check if table already exists and is fully seeded (fast path for subsequent boots)
  let existingCount = 0;
  try {
    const countResult = await db.query(
      `SELECT COUNT(*) as cnt FROM logs`
    );
    existingCount = parseInt(countResult.rows[0].cnt, 10);
  } catch (_) {
    // Table doesn't exist yet — first boot
  }

  if (existingCount >= 100000) {
    console.log(`Database already seeded with ${existingCount} rows. Skipping schema/seed.`);
    return db;
  }

  // ── First boot: create schema, indexes, seed ──────────────────────────────

  // Create table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id        BIGSERIAL PRIMARY KEY,
      ts        TIMESTAMPTZ NOT NULL,
      severity  TEXT        NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service   TEXT        NOT NULL,
      message   TEXT        NOT NULL
    );
  `);

  // Try to enable pg_trgm for better substring search (GIN index)
  let hasTrgm = false;
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    hasTrgm = true;
    console.log('pg_trgm extension loaded.');
  } catch (e) {
    // pg_trgm not available in this PGLite build
  }

  // Create indexes
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);
  `);

  if (hasTrgm) {
    // GIN trigram index supports fast arbitrary substring search
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_message_trgm
        ON logs USING GIN (lower(message) gin_trgm_ops);
    `);
  } else {
    // Fallback: text_pattern_ops supports prefix search (partial help for LIKE)
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_message_lower
        ON logs (lower(message) text_pattern_ops);
    `);
  }

  console.log('Seeding 100,000 log entries...');
  const seedStart = Date.now();

  const rand = mulberry32(0xdeadbeef);
  const TOTAL_ROWS = 100000;
  const BATCH_SIZE = 1000;

  for (let batchStart = 0; batchStart < TOTAL_ROWS; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL_ROWS);
    const rows = [];

    for (let i = batchStart; i < batchEnd; i++) {
      rows.push(generateRow(i, rand));
    }

    // Build a single multi-row INSERT
    const values = rows.map((r, idx) => {
      const base = idx * 4;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
    }).join(', ');

    const params = rows.flatMap((r) => [r.ts, r.severity, r.service, r.message]);

    await db.query(
      `INSERT INTO logs (ts, severity, service, message) VALUES ${values}`,
      params
    );

    if ((batchStart / BATCH_SIZE + 1) % 10 === 0) {
      console.log(`  Seeded ${batchEnd} / ${TOTAL_ROWS} rows...`);
    }
  }

  const seedDuration = ((Date.now() - seedStart) / 1000).toFixed(1);
  console.log(`Seeding complete in ${seedDuration}s.`);

  return db;
}

// ─── Express app ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

let db;

// GET /api/logs
app.get('/api/logs', async (req, res) => {
  try {
    const rawOffset = req.query.offset;
    const rawLimit = req.query.limit;
    const severity = req.query.severity || '';
    const q = req.query.q || '';

    // Parse and validate
    const offset = rawOffset !== undefined ? parseInt(rawOffset, 10) : 0;
    const limit = rawLimit !== undefined ? parseInt(rawLimit, 10) : 100;

    if (!Number.isInteger(offset) || isNaN(offset) || offset < 0) {
      return res.status(400).json({ error: 'offset must be a non-negative integer' });
    }
    if (!Number.isInteger(limit) || isNaN(limit) || limit < 1 || limit > MAX_LIMIT) {
      return res.status(400).json({ error: `limit must be between 1 and ${MAX_LIMIT}` });
    }
    if (severity && !VALID_SEVERITIES.has(severity)) {
      return res.status(400).json({ error: `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}` });
    }

    // Build WHERE clause
    const conditions = [];
    const params = [];

    if (severity) {
      params.push(severity);
      conditions.push(`severity = $${params.length}`);
    }

    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      conditions.push(`lower(message) LIKE $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count query
    const countSql = `SELECT COUNT(*) as total FROM logs ${where}`;
    const countResult = await db.query(countSql, params);
    const total = parseInt(countResult.rows[0].total, 10);

    // Data query
    const dataSql = `
      SELECT id, ts, severity, service, message
      FROM logs
      ${where}
      ORDER BY ts DESC, id DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;
    const dataResult = await db.query(dataSql, [...params, limit, offset]);

    res.json({ total, rows: dataResult.rows });
  } catch (err) {
    console.error('Error in GET /api/logs:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/stats
app.get('/api/stats', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE severity = 'debug') as debug,
        COUNT(*) FILTER (WHERE severity = 'info')  as info,
        COUNT(*) FILTER (WHERE severity = 'warn')  as warn,
        COUNT(*) FILTER (WHERE severity = 'error') as error
      FROM logs
    `);

    const row = result.rows[0];
    res.json({
      total: parseInt(row.total, 10),
      bySeverity: {
        debug: parseInt(row.debug, 10),
        info: parseInt(row.info, 10),
        warn: parseInt(row.warn, 10),
        error: parseInt(row.error, 10),
      },
    });
  } catch (err) {
    console.error('Error in GET /api/stats:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
const bootStart = Date.now();
db = await initDatabase();
const bootDuration = ((Date.now() - bootStart) / 1000).toFixed(1);
console.log(`Boot complete in ${bootDuration}s. Starting server on port ${PORT}...`);

app.listen(PORT, () => {
  console.log(`Log Explorer API listening on http://localhost:${PORT}`);
});
