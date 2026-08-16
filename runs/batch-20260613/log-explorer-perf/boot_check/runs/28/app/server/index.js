import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '.pglite');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

let db;

const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SERVICES = ['api', 'auth', 'db', 'frontend', 'worker', 'cache', 'queue', 'monitor'];

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

async function seedDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL
    )
  `);

  // Create indexes (idempotent)
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_message ON logs (message)');

  const countRes = await db.query('SELECT COUNT(*) as count FROM logs');
  const count = parseInt(countRes.rows[0].count, 10);
  if (count > 0) {
    console.log(`Database already seeded with ${count} rows. Skipping seed.`);
    return;
  }

  console.log('Seeding 100,000 log entries...');
  const startTime = Date.now();

  const BATCH_SIZE = 1000;
  const TOTAL_ROWS = 100000;
  const random = seededRandom(42);
  const baseTime = new Date('2024-06-01T00:00:00Z').getTime();
  const timeSpan = 30 * 24 * 60 * 60 * 1000; // 30 days

  const messageTemplates = [
    'User {id} performed action {action} from IP {ip}',
    'Request to {endpoint} completed in {time}ms with status {status}',
    'Cache {op} for key {key} {result}',
    'Database query {query} took {time}ms',
    'Service {service} {event} {details}',
    'Authentication {result} for user {user}',
    'Worker processed job {jobId} {status}',
    'Monitor alert: {metric} {threshold} {value}'
  ];

  const actions = ['login', 'logout', 'update', 'delete', 'create'];
  const endpoints = ['/users', '/orders', '/products', '/auth', '/search'];
  const ips = ['192.168.1.', '10.0.0.', '172.16.0.'];
  const keys = ['user:123', 'session:abc', 'data:xyz', 'config:1'];
  const results = ['hit', 'miss', 'evicted'];
  const ops = ['read', 'write', 'invalidate'];
  const queryTypes = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
  const events = ['started', 'stopped', 'restarted', 'failed'];
  const detailsList = ['successfully', 'with error', 'after retry'];
  const authResults = ['success', 'failure', 'timeout'];
  const jobStatuses = ['completed', 'failed', 'retrying'];
  const metrics = ['cpu', 'memory', 'disk', 'latency'];
  const thresholds = ['above', 'below'];

  for (let batchStart = 0; batchStart < TOTAL_ROWS; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL_ROWS);
    const values = [];
    const params = [];
    let paramIndex = 1;

    for (let i = batchStart; i < batchEnd; i++) {
      const r = random();
      let severity;
      if (r < 0.60) severity = 'debug';
      else if (r < 0.85) severity = 'info';
      else if (r < 0.95) severity = 'warn';
      else severity = 'error';

      const service = SERVICES[Math.floor(random() * SERVICES.length)];
      const ts = new Date(baseTime + Math.floor(random() * timeSpan));
      const template = messageTemplates[Math.floor(random() * messageTemplates.length)];

      let message = template
        .replace('{id}', Math.floor(random() * 10000))
        .replace('{action}', actions[Math.floor(random() * actions.length)])
        .replace('{ip}', ips[Math.floor(random() * ips.length)] + Math.floor(random() * 255))
        .replace('{endpoint}', endpoints[Math.floor(random() * endpoints.length)])
        .replace('{time}', Math.floor(random() * 500) + 10)
        .replace('{status}', [200, 201, 400, 404, 500][Math.floor(random() * 5)])
        .replace('{op}', ops[Math.floor(random() * ops.length)])
        .replace('{key}', keys[Math.floor(random() * keys.length)])
        .replace('{result}', results[Math.floor(random() * results.length)])
        .replace('{query}', queryTypes[Math.floor(random() * queryTypes.length)])
        .replace('{service}', service)
        .replace('{event}', events[Math.floor(random() * events.length)])
        .replace('{details}', detailsList[Math.floor(random() * detailsList.length)])
        .replace('{user}', 'user' + Math.floor(random() * 1000))
        .replace('{jobId}', 'job-' + Math.floor(random() * 100000))
        .replace('{status}', jobStatuses[Math.floor(random() * jobStatuses.length)])
        .replace('{metric}', metrics[Math.floor(random() * metrics.length)])
        .replace('{threshold}', thresholds[Math.floor(random() * thresholds.length)])
        .replace('{value}', (random() * 100).toFixed(2));

      // Add some searchable terms for testing
      if (i % 100 === 0) message += ' ERROR critical failure';
      if (i % 50 === 0) message += ' timeout occurred';

      values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
      params.push(ts.toISOString(), severity, service, message);
    }

    const insertSql = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`;
    await db.query(insertSql, params);
    if (batchStart % 10000 === 0) {
      console.log(`Seeded ${batchEnd} rows...`);
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Seeding complete in ${duration}s.`);
}

function validateParams(req, res) {
  const { offset = '0', limit = '100', severity, q } = req.query;
  const off = parseInt(offset, 10);
  const lim = parseInt(limit, 10);

  if (isNaN(off) || off < 0) {
    res.status(400).json({ error: 'Invalid offset: must be non-negative integer' });
    return null;
  }
  if (isNaN(lim) || lim < 1 || lim > 200) {
    res.status(400).json({ error: 'Invalid limit: must be between 1 and 200' });
    return null;
  }
  if (severity && !SEVERITIES.includes(severity)) {
    res.status(400).json({ error: `Invalid severity: must be one of ${SEVERITIES.join(', ')}` });
    return null;
  }
  return { offset: off, limit: lim, severity, q: q || null };
}

app.get('/api/logs', async (req, res) => {
  const params = validateParams(req, res);
  if (!params) return;

  const { offset, limit, severity, q } = params;

  try {
    let whereClauses = [];
    let queryParams = [];
    let paramIdx = 1;

    if (severity) {
      whereClauses.push(`severity = $${paramIdx++}`);
      queryParams.push(severity);
    }
    if (q) {
      whereClauses.push(`LOWER(message) LIKE $${paramIdx++}`);
      queryParams.push(`%${q.toLowerCase()}%`);
    }

    const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Total count
    const countSql = `SELECT COUNT(*) as total FROM logs ${where}`;
    const countRes = await db.query(countSql, queryParams);
    const total = parseInt(countRes.rows[0].total, 10);

    // Rows
    const rowsSql = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${where}
      ORDER BY ts DESC 
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    const rowParams = [...queryParams, limit, offset];
    const rowsRes = await db.query(rowsSql, rowParams);

    res.json({ total, rows: rowsRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const totalRes = await db.query('SELECT COUNT(*) as total FROM logs');
    const total = parseInt(totalRes.rows[0].total, 10);

    const sevRes = await db.query(`
      SELECT severity, COUNT(*) as count 
      FROM logs 
      GROUP BY severity
    `);
    const perSeverity = {};
    SEVERITIES.forEach(s => perSeverity[s] = 0);
    sevRes.rows.forEach(row => {
      perSeverity[row.severity] = parseInt(row.count, 10);
    });

    res.json({ total, perSeverity });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function startServer() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    db = new PGlite({ dataDir: DATA_DIR });
    await db.waitReady;
    console.log('PGlite initialized.');

    await seedDatabase();

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();