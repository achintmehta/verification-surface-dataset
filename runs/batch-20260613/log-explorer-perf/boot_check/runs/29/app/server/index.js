import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = join(__dirname, 'logs.db');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

let db = null;
let isSeeded = false;

const SERVICES = ['api', 'auth', 'db', 'worker', 'frontend', 'cache', 'queue', 'scheduler'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_WEIGHTS = [0.60, 0.25, 0.10, 0.05]; // cumulative for distribution

const MESSAGE_TEMPLATES = [
  'User {user} logged in from {ip}',
  'Request to {endpoint} completed in {ms}ms',
  'Database query {query} returned {rows} rows',
  'Cache {action} for key {key} {result}',
  'Background job {job} {status} after {duration}s',
  'Connection from {client} {action}',
  'File {file} {action} {size} bytes',
  'Service {service} health check {status}',
  'Error processing request {id}: {reason}',
  'Metric {metric} recorded value {value}'
];

const VAR_FRAGMENTS = {
  user: ['alice', 'bob', 'charlie', 'dave', 'eve', 'admin', 'guest'],
  ip: ['192.168.1.1', '10.0.0.5', '172.16.0.10', '203.0.113.45'],
  endpoint: ['/api/users', '/api/orders', '/login', '/dashboard', '/api/logs'],
  ms: ['12', '45', '120', '8', '300'],
  query: ['SELECT * FROM users', 'UPDATE logs SET ts=now()', 'INSERT INTO events'],
  rows: ['1', '42', '1000', '0'],
  action: ['hit', 'miss', 'evict', 'set', 'opened', 'closed'],
  key: ['user:123', 'session:abc', 'cache:home'],
  result: ['success', 'failed', 'timeout'],
  job: ['email-sender', 'report-gen', 'cleanup'],
  status: ['completed', 'failed', 'retrying'],
  duration: ['0.5', '2.3', '15', '0.1'],
  client: ['mobile-app', 'web-ui', 'cli-tool'],
  file: ['report.pdf', 'data.csv', 'config.json'],
  size: ['1024', '45000', '1200000'],
  service: SERVICES,
  metric: ['cpu', 'memory', 'requests', 'latency'],
  value: ['42.5', '78', '1200', '0.99'],
  reason: ['timeout', 'invalid input', 'permission denied', 'not found'],
  id: ['req-001', 'req-002', 'tx-999']
};

let seed = 12345;
function seededRandom() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

function getRandomSeverity(rowNum) {
  const r = seededRandom();
  let cum = 0;
  for (let i = 0; i < SEVERITIES.length; i++) {
    cum += SEVERITY_WEIGHTS[i];
    if (r <= cum) return SEVERITIES[i];
  }
  return 'info';
}

function generateMessage(rowNum) {
  const template = MESSAGE_TEMPLATES[Math.floor(seededRandom() * MESSAGE_TEMPLATES.length)];
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const arr = VAR_FRAGMENTS[key] || ['unknown'];
    return arr[Math.floor(seededRandom() * arr.length)];
  });
}

async function initDb() {
  console.log('Initializing PGLite...');
  db = new PGlite(DB_PATH);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);

  // Check if already seeded
  const countRes = await db.query('SELECT COUNT(*) as count FROM logs');
  const count = parseInt(countRes.rows[0].count);
  console.log(`Existing log count: ${count}`);

  if (count >= 100000) {
    console.log('Database already seeded with 100k+ rows. Skipping seed.');
    isSeeded = true;
    await createIndexes();
    return;
  }

  console.log('Seeding 100,000 log entries...');
  const startTime = Date.now();

  // Create indexes before seeding for better perf? But for initial seed, maybe after.
  await seedLogs();

  await createIndexes();

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Seeding completed in ${duration}s`);
  isSeeded = true;
}

async function createIndexes() {
  console.log('Creating indexes...');
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_message ON logs USING gin (to_tsvector('simple', message));
  `);
  console.log('Indexes created.');
}

async function seedLogs() {
  const TOTAL_ROWS = 100000;
  const BATCH_SIZE = 5000;
  const START_DATE = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

  await db.exec('BEGIN;');

  try {
    for (let batch = 0; batch < TOTAL_ROWS / BATCH_SIZE; batch++) {
      const values = [];
      const params = [];
      let paramIndex = 1;

      for (let i = 0; i < BATCH_SIZE; i++) {
        const rowNum = batch * BATCH_SIZE + i;
        // Deterministic but spread timestamps
        const ts = new Date(START_DATE.getTime() + (rowNum / TOTAL_ROWS) * 30 * 24 * 60 * 60 * 1000 + seededRandom() * 1000);
        const severity = getRandomSeverity(rowNum);
        const service = SERVICES[rowNum % SERVICES.length];
        const message = generateMessage(rowNum);

        values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
        params.push(ts.toISOString(), severity, service, message);
      }

      const query = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`;
      await db.query(query, params);

      if (batch % 4 === 0) {
        console.log(`  Seeded ${(batch + 1) * BATCH_SIZE} rows...`);
      }
    }
    await db.exec('COMMIT;');
    console.log('Seed transaction committed.');
  } catch (err) {
    await db.exec('ROLLBACK;');
    console.error('Seeding failed, rolled back:', err);
    throw err;
  }
}

function validateParams(req, res) {
  const { offset, limit, severity, q } = req.query;

  if (offset !== undefined) {
    const o = parseInt(offset);
    if (isNaN(o) || o < 0) {
      res.status(400).json({ error: 'Invalid offset: must be non-negative integer' });
      return false;
    }
  }

  if (limit !== undefined) {
    const l = parseInt(limit);
    if (isNaN(l) || l < 1 || l > 200) {
      res.status(400).json({ error: 'Invalid limit: must be between 1 and 200' });
      return false;
    }
  }

  if (severity && !['debug', 'info', 'warn', 'error'].includes(severity)) {
    res.status(400).json({ error: 'Invalid severity' });
    return false;
  }

  return true;
}

app.get('/api/logs', async (req, res) => {
  if (!validateParams(req, res)) return;

  const offset = parseInt(req.query.offset) || 0;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const severity = req.query.severity;
  const q = req.query.q;

  try {
    let whereClauses = [];
    let params = [];
    let paramIndex = 1;

    if (severity) {
      whereClauses.push(`severity = $${paramIndex++}`);
      params.push(severity);
    }

    if (q) {
      // Use ILIKE for case-insensitive substring, or to_tsvector but ILIKE is simple and works
      whereClauses.push(`message ILIKE $${paramIndex++}`);
      params.push(`%${q}%`);
    }

    const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Count query
    const countQuery = `SELECT COUNT(*) as total FROM logs ${where}`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].total);

    // Data query with window
    const dataParams = [...params];
    dataParams.push(limit, offset);
    const dataQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${where}
      ORDER BY ts DESC 
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
    const dataRes = await db.query(dataQuery, dataParams);

    res.json({
      total,
      rows: dataRes.rows
    });
  } catch (err) {
    console.error('Query error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE severity = 'debug') as debug,
        COUNT(*) FILTER (WHERE severity = 'info') as info,
        COUNT(*) FILTER (WHERE severity = 'warn') as warn,
        COUNT(*) FILTER (WHERE severity = 'error') as error
      FROM logs
    `);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function startServer() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log('Ready to serve log explorer.');
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();