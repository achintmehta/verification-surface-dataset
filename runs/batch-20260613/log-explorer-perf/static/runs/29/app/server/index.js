import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'logs.db');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

let db = null;
let isSeeding = false;

const SERVICES = ['auth', 'api', 'db', 'frontend', 'worker', 'cache', 'queue', 'monitor'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_WEIGHTS = [0.60, 0.25, 0.10, 0.05]; // cumulative for selection

const MESSAGE_TEMPLATES = [
  'User {id} logged in from {ip}',
  'Request to {endpoint} completed in {ms}ms',
  'Database query {query} returned {rows} rows',
  'Cache {action} for key {key} {result}',
  'Worker processed job {jobId} with status {status}',
  'Authentication {result} for user {user}',
  'API rate limit {action} for client {client}',
  'Service {service} started successfully',
  'Error processing {entity}: {reason}',
  'Connection {action} to {target}'
];

function seededRandom(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function getDeterministicValue(seed, max) {
  return Math.floor(seededRandom(seed) * max);
}

function selectSeverity(seed) {
  const r = seededRandom(seed);
  let cum = 0;
  for (let i = 0; i < SEVERITIES.length; i++) {
    cum += SEVERITY_WEIGHTS[i];
    if (r < cum) return SEVERITIES[i];
  }
  return 'debug';
}

function generateMessage(seed, service) {
  const template = MESSAGE_TEMPLATES[seed % MESSAGE_TEMPLATES.length];
  const id = (seed % 10000) + 1;
  const ip = `192.168.${seed % 256}.${(seed * 7) % 256}`;
  const ms = 10 + (seed % 500);
  const endpoint = ['/users', '/orders', '/products', '/auth', '/search'][seed % 5];
  const rows = 1 + (seed % 1000);
  const query = ['SELECT *', 'INSERT', 'UPDATE', 'DELETE'][seed % 4];
  const action = ['hit', 'miss', 'evict', 'set'][seed % 4];
  const key = `key_${seed % 1000}`;
  const result = ['success', 'failed', 'timeout'][seed % 3];
  const jobId = `job_${100000 + seed % 900000}`;
  const status = ['completed', 'failed', 'retrying'][seed % 3];
  const user = `user_${id}`;
  const client = `client_${seed % 500}`;
  const entity = ['payment', 'order', 'user', 'inventory'][seed % 4];
  const reason = ['timeout', 'validation', 'not found', 'permission'][seed % 4];
  const target = ['primary-db', 'replica', 'external-api', 'queue'][seed % 4];

  return template
    .replace('{id}', id)
    .replace('{ip}', ip)
    .replace('{ms}', ms)
    .replace('{endpoint}', endpoint)
    .replace('{rows}', rows)
    .replace('{query}', query)
    .replace('{action}', action)
    .replace('{key}', key)
    .replace('{result}', result)
    .replace('{jobId}', jobId)
    .replace('{status}', status)
    .replace('{user}', user)
    .replace('{client}', client)
    .replace('{entity}', entity)
    .replace('{reason}', reason)
    .replace('{target}', target)
    .replace('{service}', service);
}

async function seedDatabase() {
  if (isSeeding) return;
  isSeeding = true;

  console.log('Checking if database needs seeding...');

  const countResult = await db.query('SELECT COUNT(*) as count FROM logs');
  const count = parseInt(countResult.rows[0].count);

  if (count >= 100000) {
    console.log(`Database already has ${count} rows, skipping seed.`);
    isSeeding = false;
    return;
  }

  console.log('Seeding 100,000 log entries...');
  const startTime = Date.now();

  const TOTAL_ROWS = 100000;
  const BATCH_SIZE = 5000;
  const START_DATE = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
  const TIME_SPAN = 30 * 24 * 60 * 60 * 1000; // ms in 30 days

  await db.query('BEGIN');

  try {
    for (let batch = 0; batch < TOTAL_ROWS / BATCH_SIZE; batch++) {
      const values = [];
      const params = [];
      let paramIndex = 1;

      for (let i = 0; i < BATCH_SIZE; i++) {
        const rowNum = batch * BATCH_SIZE + i;
        const seed = rowNum * 123456789; // deterministic seed

        const ts = new Date(START_DATE.getTime() + (seededRandom(seed) * TIME_SPAN));
        const severity = selectSeverity(seed + 1);
        const service = SERVICES[seed % SERVICES.length];
        const message = generateMessage(seed + 2, service);

        values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
        params.push(ts.toISOString(), severity, service, message, rowNum);
      }

      const query = `
        INSERT INTO logs (ts, severity, service, message, id)
        VALUES ${values.join(', ')}
      `;
      await db.query(query, params);

      if (batch % 4 === 0) {
        console.log(`Seeded ${(batch + 1) * BATCH_SIZE} rows...`);
      }
    }

    await db.query('COMMIT');
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Seeding completed in ${duration}s`);
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Seeding failed:', err);
    throw err;
  } finally {
    isSeeding = false;
  }
}

async function initializeDatabase() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  db = new PGlite(DB_PATH);

  await db.waitReady;

  // Create table
  await db.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL
    )
  `);

  // Create indexes for performance
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_service ON logs (service)');

  // For message search, a simple index won't help ILIKE much, but we can add for completeness
  // PGLite may support basic, 100k is manageable

  console.log('Database initialized with indexes.');

  await seedDatabase();
}

function validateParams(req, res) {
  const { offset, limit, severity, q } = req.query;

  if (offset !== undefined) {
    const off = parseInt(offset);
    if (isNaN(off) || off < 0) {
      res.status(400).json({ error: 'offset must be a non-negative integer' });
      return false;
    }
  }

  if (limit !== undefined) {
    const lim = parseInt(limit);
    if (isNaN(lim) || lim < 1 || lim > 200) {
      res.status(400).json({ error: 'limit must be between 1 and 200' });
      return false;
    }
  }

  if (severity !== undefined && severity !== '') {
    if (!['debug', 'info', 'warn', 'error'].includes(severity)) {
      res.status(400).json({ error: 'Invalid severity value' });
      return false;
    }
  }

  return true;
}

app.get('/api/logs', async (req, res) => {
  if (!validateParams(req, res)) return;

  const offset = parseInt(req.query.offset) || 0;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const severity = req.query.severity || null;
  const q = req.query.q || null;

  try {
    let whereClauses = [];
    let params = [];
    let paramIndex = 1;

    if (severity) {
      whereClauses.push(`severity = $${paramIndex++}`);
      params.push(severity);
    }

    if (q) {
      whereClauses.push(`message ILIKE $${paramIndex++}`);
      params.push(`%${q}%`);
    }

    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM logs ${where}`;
    const countResult = await db.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total);

    // Get rows - note: for deep offsets, this uses OFFSET which can be slow, but for 100k ok, and budgets allow
    // To optimize deep pages, could use keyset but for simplicity and since 100k fast:
    const dataQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${where}
      ORDER BY ts DESC, id DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
    params.push(limit, offset);

    const dataResult = await db.query(dataQuery, params);

    res.json({
      total,
      rows: dataResult.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const totalResult = await db.query('SELECT COUNT(*) as total FROM logs');
    const total = parseInt(totalResult.rows[0].total);

    const severityResult = await db.query(`
      SELECT severity, COUNT(*) as count 
      FROM logs 
      GROUP BY severity
    `);

    const bySeverity = {};
    SEVERITIES.forEach(s => bySeverity[s] = 0);
    severityResult.rows.forEach(row => {
      bySeverity[row.severity] = parseInt(row.count);
    });

    res.json({ total, bySeverity });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function startServer() {
  try {
    await initializeDatabase();
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();
