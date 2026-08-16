import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, 'data', 'pglite');

// Ensure data directory exists
mkdirSync(DB_DIR, { recursive: true });

const PUBLIC_DIR = join(__dirname, 'public');

const app = express();
app.use(cors());
app.use(express.json());

// Serve built frontend if available
if (existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
}

const PORT = process.env.PORT || 3001;

// ─── Constants ────────────────────────────────────────────────────────────────
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_SET = new Set(SEVERITIES);

// Severity distribution: ~60% debug, ~25% info, ~10% warn, ~5% error
const SEVERITY_WEIGHTS = [60, 25, 10, 5];
const SEVERITY_CUMULATIVE = SEVERITY_WEIGHTS.reduce((acc, w, i) => {
  acc.push((acc[i - 1] || 0) + w);
  return acc;
}, []);

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

const MESSAGE_TEMPLATES = [
  // Selective terms (rare)
  'CRITICAL: database connection pool exhausted for {service}',
  'SSL certificate expiry warning for domain {domain}',
  'Deadlock detected in transaction {txid}',
  'Memory threshold exceeded: {pct}% used on node {node}',
  'Circuit breaker OPEN for downstream {service}',
  // Semi-selective
  'Request timeout after {ms}ms calling {endpoint}',
  'Retry attempt {n} of 3 for job {jobid}',
  'Cache miss for key {key} in region {region}',
  'Rate limit exceeded for client {clientid}',
  'Authentication failed for user {userid}',
  // Non-selective (common)
  'Processed request {reqid} in {ms}ms',
  'Health check passed for {service}',
  'Connected to {service} successfully',
  'Starting batch job {jobid}',
  'Completed batch job {jobid} with {n} records',
  'User {userid} logged in from {ip}',
  'Fetched {n} records from {table}',
  'Updated record {id} in {table}',
  'Deleted {n} stale sessions',
  'Scheduled task {task} triggered at {ts}',
  'Config reloaded for {service}',
  'Metrics flushed: {n} data points',
  'Queue depth: {n} messages pending',
  'Deployed version {version} to {env}',
  'Rollback initiated for deployment {depid}',
];

// ─── Deterministic PRNG (mulberry32) ─────────────────────────────────────────
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickSeverity(rand) {
  const r = rand() * 100;
  for (let i = 0; i < SEVERITY_CUMULATIVE.length; i++) {
    if (r < SEVERITY_CUMULATIVE[i]) return SEVERITIES[i];
  }
  return SEVERITIES[0];
}

function pickService(rand) {
  return SERVICES[Math.floor(rand() * SERVICES.length)];
}

function renderTemplate(template, rand) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    switch (key) {
      case 'service': return SERVICES[Math.floor(rand() * SERVICES.length)];
      case 'domain': return `svc-${Math.floor(rand() * 20)}.example.com`;
      case 'txid': return `txn-${Math.floor(rand() * 1e6).toString(16)}`;
      case 'pct': return Math.floor(rand() * 40 + 60);
      case 'node': return `node-${Math.floor(rand() * 16)}`;
      case 'ms': return Math.floor(rand() * 5000 + 10);
      case 'endpoint': return `/api/v${Math.floor(rand() * 3) + 1}/${['users','orders','products','payments'][Math.floor(rand() * 4)]}`;
      case 'n': return Math.floor(rand() * 10000);
      case 'jobid': return `job-${Math.floor(rand() * 1e5).toString(36)}`;
      case 'key': return `cache:${['user','session','product','order'][Math.floor(rand() * 4)]}:${Math.floor(rand() * 1e6)}`;
      case 'region': return ['us-east-1','us-west-2','eu-west-1','ap-southeast-1'][Math.floor(rand() * 4)];
      case 'clientid': return `client-${Math.floor(rand() * 500)}`;
      case 'userid': return `user-${Math.floor(rand() * 10000)}`;
      case 'reqid': return `req-${Math.floor(rand() * 1e7).toString(36)}`;
      case 'ip': return `${Math.floor(rand()*256)}.${Math.floor(rand()*256)}.${Math.floor(rand()*256)}.${Math.floor(rand()*256)}`;
      case 'table': return ['users','orders','products','sessions','events'][Math.floor(rand() * 5)];
      case 'id': return Math.floor(rand() * 1e6);
      case 'task': return ['cleanup','report','sync','backup'][Math.floor(rand() * 4)];
      case 'ts': return new Date(Date.now() - Math.floor(rand() * 86400000)).toISOString();
      case 'version': return `${Math.floor(rand()*3)+1}.${Math.floor(rand()*20)}.${Math.floor(rand()*100)}`;
      case 'env': return ['production','staging','canary'][Math.floor(rand() * 3)];
      case 'depid': return `dep-${Math.floor(rand() * 1e4).toString(36)}`;
      default: return key;
    }
  });
}

// ─── Seed generation ──────────────────────────────────────────────────────────
function generateRows(count = 100_000) {
  const rand = mulberry32(0xdeadbeef);
  const now = Date.now();
  const span = 30 * 24 * 60 * 60 * 1000; // 30 days in ms
  const rows = [];

  for (let i = 0; i < count; i++) {
    const ts = new Date(now - span + Math.floor(rand() * span));
    const severity = pickSeverity(rand);
    const service = pickService(rand);
    const template = MESSAGE_TEMPLATES[Math.floor(rand() * MESSAGE_TEMPLATES.length)];
    const message = renderTemplate(template, rand);
    rows.push({ ts: ts.toISOString(), severity, service, message });
  }

  return rows;
}

// ─── Database initialization ──────────────────────────────────────────────────
let db;

async function initDb() {
  console.log('Initializing PGLite database at', DB_DIR);

  // Load pg_trgm extension for fast trigram-based substring search
  let extensions = {};
  try {
    const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
    extensions = { pg_trgm };
    console.log('pg_trgm extension loaded');
  } catch (e) {
    console.warn('pg_trgm not available, falling back to LIKE:', e.message);
  }

  db = new PGlite(DB_DIR, { extensions });
  await db.waitReady;

  // Enable pg_trgm if available
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    console.log('pg_trgm extension enabled');
  } catch (e) {
    console.warn('Could not enable pg_trgm:', e.message);
  }

  // Create table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id        SERIAL PRIMARY KEY,
      ts        TIMESTAMPTZ NOT NULL,
      severity  TEXT NOT NULL,
      service   TEXT NOT NULL,
      message   TEXT NOT NULL
    );
  `);

  // Create indexes for the two main query shapes:
  // 1. ORDER BY ts DESC (all rows)
  // 2. severity = ? ORDER BY ts DESC
  // 3. message ILIKE '%q%' ORDER BY ts DESC (trigram index)
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);
  `);

  // Try to create trigram index for fast substring search
  try {
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_message_trgm
        ON logs USING gin (lower(message) gin_trgm_ops);
    `);
    console.log('Trigram index created for message search');
  } catch (e) {
    console.warn('Trigram index not available:', e.message);
    // Fallback: create a regular index on lower(message) for prefix searches
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_message_lower
        ON logs USING gin (to_tsvector('simple', lower(message)));
    `);
  }

  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*) AS cnt FROM logs');
  const existingCount = parseInt(countResult.rows[0].cnt, 10);

  if (existingCount >= 100_000) {
    console.log(`Database already seeded with ${existingCount} rows. Skipping seed.`);
    return;
  }

  console.log('Seeding 100,000 log entries...');
  const seedStart = Date.now();

  const rows = generateRows(100_000);
  const BATCH_SIZE = 1000;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const values = batch
      .map((_, j) => {
        const base = j * 4;
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
      })
      .join(', ');
    const params = batch.flatMap(r => [r.ts, r.severity, r.service, r.message]);
    await db.query(
      `INSERT INTO logs (ts, severity, service, message) VALUES ${values}`,
      params
    );

    if ((i / BATCH_SIZE) % 10 === 0) {
      console.log(`  Seeded ${i + batch.length} / 100000 rows...`);
    }
  }

  console.log(`Seeding complete in ${((Date.now() - seedStart) / 1000).toFixed(1)}s`);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/stats
app.get('/api/stats', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT severity, COUNT(*) AS cnt
      FROM logs
      GROUP BY severity
    `);

    const bySeverity = {};
    let total = 0;
    for (const row of result.rows) {
      bySeverity[row.severity] = parseInt(row.cnt, 10);
      total += parseInt(row.cnt, 10);
    }

    res.json({ total, bySeverity });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/logs
app.get('/api/logs', async (req, res) => {
  try {
    let { offset = '0', limit = '100', severity, q } = req.query;

    // Parse and validate
    offset = parseInt(offset, 10);
    limit = parseInt(limit, 10);

    if (isNaN(offset) || offset < 0) {
      return res.status(400).json({ error: 'Invalid offset: must be a non-negative integer' });
    }
    if (isNaN(limit) || limit < 1) {
      return res.status(400).json({ error: 'Invalid limit: must be a positive integer' });
    }
    if (limit > 200) {
      return res.status(400).json({ error: 'Invalid limit: maximum is 200' });
    }
    if (severity !== undefined && !SEVERITY_SET.has(severity)) {
      return res.status(400).json({ error: `Invalid severity: must be one of ${SEVERITIES.join(', ')}` });
    }

    // Build WHERE clause
    const conditions = [];
    const params = [];

    if (severity) {
      params.push(severity);
      conditions.push(`severity = $${params.length}`);
    }

    if (q && q.trim()) {
      params.push(`%${q.toLowerCase()}%`);
      conditions.push(`lower(message) LIKE $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count query
    const countResult = await db.query(
      `SELECT COUNT(*) AS cnt FROM logs ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].cnt, 10);

    // Data query
    params.push(limit, offset);
    const dataResult = await db.query(
      `SELECT id, ts, severity, service, message
       FROM logs
       ${where}
       ORDER BY ts DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      total,
      rows: dataResult.rows,
    });
  } catch (err) {
    console.error('Logs query error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// SPA fallback
if (existsSync(PUBLIC_DIR)) {
  app.get('*', (req, res) => {
    res.sendFile(join(PUBLIC_DIR, 'index.html'));
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────
async function main() {
  const bootStart = Date.now();
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`Log Explorer API running on http://localhost:${PORT}`);
      console.log(`Boot time: ${((Date.now() - bootStart) / 1000).toFixed(1)}s`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

main();
