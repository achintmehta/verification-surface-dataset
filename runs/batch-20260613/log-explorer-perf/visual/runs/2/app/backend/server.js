import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
mkdirSync(DATA_DIR, { recursive: true });

const PORT = 3001;
const SEED_COUNT = 100_000;
const MAX_LIMIT = 200;

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

// ─── Seed data generators ────────────────────────────────────────────────────
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
  // debug
  (r) => `Processing request ${r.reqId} for user ${r.userId}`,
  (r) => `Cache lookup for key ${r.cacheKey} returned ${r.hit ? 'HIT' : 'MISS'}`,
  (r) => `DB query executed in ${r.ms}ms: SELECT * FROM ${r.table} WHERE id=${r.id}`,
  (r) => `Heartbeat check passed for node ${r.node}`,
  (r) => `Serializing response payload of ${r.bytes} bytes`,
  (r) => `Token validation completed for session ${r.session}`,
  // info
  (r) => `User ${r.userId} logged in from ${r.ip}`,
  (r) => `Order ${r.orderId} created successfully for customer ${r.userId}`,
  (r) => `Payment of $${r.amount} processed via ${r.method}`,
  (r) => `Email notification sent to ${r.email}`,
  (r) => `Inventory updated: item ${r.itemId} quantity changed to ${r.qty}`,
  (r) => `Search query "${r.query}" returned ${r.count} results in ${r.ms}ms`,
  (r) => `Service ${r.svc} started on port ${r.port}`,
  (r) => `Configuration reloaded from ${r.configPath}`,
  // warn
  (r) => `Slow query detected: ${r.ms}ms for SELECT on ${r.table}`,
  (r) => `Rate limit approaching for user ${r.userId}: ${r.count}/${r.limit} requests`,
  (r) => `Retry attempt ${r.attempt} of ${r.maxAttempts} for request ${r.reqId}`,
  (r) => `Memory usage at ${r.pct}% on node ${r.node}`,
  (r) => `Deprecated API endpoint /v1/${r.endpoint} called by ${r.client}`,
  (r) => `Connection pool exhausted: waiting for available connection`,
  // error
  (r) => `Failed to connect to database after ${r.attempt} retries`,
  (r) => `Unhandled exception in ${r.svc}: ${r.error}`,
  (r) => `Payment gateway timeout for order ${r.orderId}`,
  (r) => `Authentication failed for user ${r.userId}: invalid credentials`,
];

function pickSeverity(rand) {
  const v = rand();
  let acc = 0;
  for (let i = 0; i < SEVERITY_WEIGHTS.length; i++) {
    acc += SEVERITY_WEIGHTS[i];
    if (v < acc) return SEVERITIES[i];
  }
  return SEVERITIES[SEVERITIES.length - 1];
}

function generateRow(i, rand) {
  const svc = SERVICES[Math.floor(rand() * SERVICES.length)];
  const severity = pickSeverity(rand);

  // Spread 100k rows over 30 days (2592000 seconds)
  // Use deterministic timestamp: base + offset proportional to i with some jitter
  const BASE_TS = new Date('2024-01-01T00:00:00Z').getTime();
  const RANGE_MS = 30 * 24 * 60 * 60 * 1000;
  const ts = new Date(BASE_TS + Math.floor((i / SEED_COUNT) * RANGE_MS + rand() * 1000));

  const userId = Math.floor(rand() * 10000) + 1;
  const reqId = `req-${Math.floor(rand() * 1000000).toString(16).padStart(6, '0')}`;
  const orderId = `ord-${Math.floor(rand() * 100000).toString(16).padStart(5, '0')}`;
  const itemId = `item-${Math.floor(rand() * 5000) + 1}`;
  const ms = Math.floor(rand() * 2000) + 1;
  const bytes = Math.floor(rand() * 65536) + 64;
  const table = ['users', 'orders', 'products', 'sessions', 'events'][Math.floor(rand() * 5)];
  const id = Math.floor(rand() * 1000000) + 1;
  const node = `node-${Math.floor(rand() * 16) + 1}`;
  const session = `sess-${Math.floor(rand() * 1000000).toString(16).padStart(6, '0')}`;
  const ip = `10.${Math.floor(rand() * 256)}.${Math.floor(rand() * 256)}.${Math.floor(rand() * 256)}`;
  const amount = (rand() * 999 + 1).toFixed(2);
  const method = ['stripe', 'paypal', 'bank_transfer', 'crypto'][Math.floor(rand() * 4)];
  const email = `user${userId}@example.com`;
  const qty = Math.floor(rand() * 1000) + 1;
  const searchTerms = ['widget', 'gadget', 'connector', 'adapter', 'module', 'plugin', 'service', 'handler'];
  const query = searchTerms[Math.floor(rand() * searchTerms.length)];
  const count = Math.floor(rand() * 10000);
  const port = 3000 + Math.floor(rand() * 1000);
  const configPath = `/etc/config/${svc}.yaml`;
  const pct = Math.floor(rand() * 100);
  const limit = [100, 500, 1000][Math.floor(rand() * 3)];
  const attempt = Math.floor(rand() * 5) + 1;
  const maxAttempts = 5;
  const endpoint = ['users', 'orders', 'products'][Math.floor(rand() * 3)];
  const client = `client-${Math.floor(rand() * 100) + 1}`;
  const cacheKey = `${table}:${id}`;
  const hit = rand() > 0.3;
  const errors = ['NullPointerException', 'TimeoutError', 'ConnectionRefused', 'OutOfMemoryError'];
  const error = errors[Math.floor(rand() * errors.length)];

  const vars = {
    reqId, userId, orderId, itemId, ms, bytes, table, id, node, session,
    ip, amount, method, email, qty, query, count, port, configPath, pct,
    limit, attempt, maxAttempts, endpoint, client, cacheKey, hit, error, svc,
  };

  // Pick template based on severity
  const sevIdx = SEVERITIES.indexOf(severity);
  const templateRanges = [[0, 6], [6, 14], [14, 20], [20, 24]];
  const [start, end] = templateRanges[sevIdx];
  const tmpl = MESSAGE_TEMPLATES[start + Math.floor(rand() * (end - start))];
  const message = tmpl(vars);

  return { ts: ts.toISOString(), severity, service: svc, message };
}

// ─── Database initialization ─────────────────────────────────────────────────
async function initDb() {
  console.log('Initializing PGLite database...');
  const db = new PGlite(join(DATA_DIR, 'logs.db'));

  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id        SERIAL PRIMARY KEY,
      ts        TIMESTAMPTZ NOT NULL,
      severity  TEXT        NOT NULL,
      service   TEXT        NOT NULL,
      message   TEXT        NOT NULL
    );
  `);

  // Create indexes for the query shapes
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_message_lower ON logs (lower(message));
  `);

  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*) AS cnt FROM logs');
  const existingCount = parseInt(countResult.rows[0].cnt, 10);

  if (existingCount >= SEED_COUNT) {
    console.log(`Database already seeded with ${existingCount} rows. Skipping seed.`);
    return db;
  }

  console.log(`Seeding ${SEED_COUNT} rows...`);
  const seedStart = Date.now();
  const rand = mulberry32(0xdeadbeef);

  // Batch insert: 1000 rows per batch
  const BATCH_SIZE = 1000;
  const batches = Math.ceil(SEED_COUNT / BATCH_SIZE);

  for (let b = 0; b < batches; b++) {
    const start = b * BATCH_SIZE;
    const end = Math.min(start + BATCH_SIZE, SEED_COUNT);
    const rows = [];

    for (let i = start; i < end; i++) {
      rows.push(generateRow(i, rand));
    }

    // Build a single multi-row INSERT
    const values = rows.map((r, idx) => {
      const base = idx * 4;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
    }).join(', ');

    const params = rows.flatMap(r => [r.ts, r.severity, r.service, r.message]);

    await db.query(
      `INSERT INTO logs (ts, severity, service, message) VALUES ${values}`,
      params
    );

    if ((b + 1) % 20 === 0) {
      console.log(`  Seeded ${end} / ${SEED_COUNT} rows...`);
    }
  }

  const elapsed = ((Date.now() - seedStart) / 1000).toFixed(1);
  console.log(`Seeding complete in ${elapsed}s`);
  return db;
}

// ─── Express app ─────────────────────────────────────────────────────────────
async function main() {
  const bootStart = Date.now();
  const db = await initDb();

  const app = express();
  app.use(cors());
  app.use(express.json());

  // ── GET /api/logs ──────────────────────────────────────────────────────────
  app.get('/api/logs', async (req, res) => {
    try {
      const rawOffset = req.query.offset;
      const rawLimit = req.query.limit;
      const severity = req.query.severity;
      const q = req.query.q;

      // Parse and validate
      const offset = rawOffset !== undefined ? parseInt(rawOffset, 10) : 0;
      const limit = rawLimit !== undefined ? parseInt(rawLimit, 10) : 100;

      if (!Number.isInteger(offset) || offset < 0) {
        return res.status(400).json({ error: 'offset must be a non-negative integer' });
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        return res.status(400).json({ error: `limit must be between 1 and ${MAX_LIMIT}` });
      }
      if (severity !== undefined && !SEVERITIES.includes(severity)) {
        return res.status(400).json({ error: `severity must be one of: ${SEVERITIES.join(', ')}` });
      }

      // Build WHERE clause
      const conditions = [];
      const params = [];

      if (severity) {
        params.push(severity);
        conditions.push(`severity = $${params.length}`);
      }
      if (q && q.trim()) {
        params.push(`%${q.trim().toLowerCase()}%`);
        conditions.push(`lower(message) LIKE $${params.length}`);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Count query
      const countSql = `SELECT COUNT(*) AS cnt FROM logs ${where}`;
      const countResult = await db.query(countSql, params);
      const total = parseInt(countResult.rows[0].cnt, 10);

      // Data query
      const dataParams = [...params, limit, offset];
      const dataSql = `
        SELECT id, ts, severity, service, message
        FROM logs
        ${where}
        ORDER BY ts DESC, id DESC
        LIMIT $${dataParams.length - 1}
        OFFSET $${dataParams.length}
      `;
      const dataResult = await db.query(dataSql, dataParams);

      res.json({ total, rows: dataResult.rows });
    } catch (err) {
      console.error('Error in GET /api/logs:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/stats ─────────────────────────────────────────────────────────
  app.get('/api/stats', async (req, res) => {
    try {
      const totalResult = await db.query('SELECT COUNT(*) AS cnt FROM logs');
      const total = parseInt(totalResult.rows[0].cnt, 10);

      const sevResult = await db.query(
        `SELECT severity, COUNT(*) AS cnt FROM logs GROUP BY severity ORDER BY severity`
      );

      const bySeverity = {};
      for (const row of sevResult.rows) {
        bySeverity[row.severity] = parseInt(row.cnt, 10);
      }

      res.json({ total, bySeverity });
    } catch (err) {
      console.error('Error in GET /api/stats:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Health check ───────────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.listen(PORT, () => {
    const elapsed = ((Date.now() - bootStart) / 1000).toFixed(1);
    console.log(`Server listening on http://localhost:${PORT} (boot: ${elapsed}s)`);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
