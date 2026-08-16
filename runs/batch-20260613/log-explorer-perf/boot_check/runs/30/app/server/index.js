import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

const DATA_DIR = './.pglite';
let db;

const SERVICES = ['auth', 'payment', 'user', 'order', 'inventory', 'notification', 'analytics', 'gateway'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_WEIGHTS = [0.60, 0.25, 0.10, 0.05];
const MESSAGE_TEMPLATES = [
  'User {id} logged in from {ip}',
  'Payment {amount} processed for order {id}',
  'Failed to connect to {service} service',
  'Cache miss for key {key}',
  'Request {id} completed in {ms}ms',
  'Database query took {ms}ms on table {table}',
  'Invalid input received: {reason}',
  'Session expired for user {id}',
  'Background job {job} started',
  'Metric {metric} reported value {value}'
];

function seededRandom(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function getSeverityForIndex(i) {
  const r = seededRandom(i * 1.1);
  let cum = 0;
  for (let j = 0; j < SEVERITIES.length; j++) {
    cum += SEVERITY_WEIGHTS[j];
    if (r < cum) return SEVERITIES[j];
  }
  return 'debug';
}

function getServiceForIndex(i) {
  return SERVICES[i % SERVICES.length];
}

function getTimestampForIndex(i) {
  // 30 days back from fixed date, spread evenly but with some variation
  const base = new Date('2024-01-01T00:00:00Z').getTime();
  const dayMs = 24 * 3600 * 1000;
  const totalSpan = 30 * dayMs;
  const offset = Math.floor((i / 100000) * totalSpan + seededRandom(i * 2.3) * 1000 * 60);
  return new Date(base + offset).toISOString();
}

function getMessageForIndex(i) {
  const template = MESSAGE_TEMPLATES[i % MESSAGE_TEMPLATES.length];
  const id = 1000 + (i % 9000);
  const ip = `192.168.${i % 256}.${(i * 7) % 256}`;
  const amount = (100 + (i % 5000)).toFixed(2);
  const ms = 10 + (i % 500);
  const key = `cache_${i % 10000}`;
  const table = ['users', 'orders', 'logs'][i % 3];
  const reason = ['missing field', 'invalid format', 'out of range'][i % 3];
  const job = ['sync', 'cleanup', 'report'][i % 3];
  const metric = ['cpu', 'memory', 'latency'][i % 3];
  const value = (seededRandom(i) * 100).toFixed(1);
  return template
    .replace('{id}', id)
    .replace('{ip}', ip)
    .replace('{amount}', amount)
    .replace('{ms}', ms)
    .replace('{key}', key)
    .replace('{table}', table)
    .replace('{reason}', reason)
    .replace('{job}', job)
    .replace('{metric}', metric)
    .replace('{value}', value)
    .replace('{service}', SERVICES[(i + 1) % SERVICES.length]);
}

async function initDb() {
  db = new PGlite({ dataDir: DATA_DIR });
  await db.waitReady;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);

  // Check if seeded
  const countRes = await db.query('SELECT COUNT(*) as count FROM logs');
  const count = parseInt(countRes.rows[0].count, 10);
  if (count >= 100000) {
    console.log('Database already seeded with', count, 'rows');
    return;
  }

  console.log('Seeding 100,000 log entries...');
  const startTime = Date.now();

  // Create indexes
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_message ON logs (message);'); // for substring, though LIKE may not use it fully

  // Batch insert
  const BATCH_SIZE = 5000;
  for (let batch = 0; batch < 20; batch++) {
    const values = [];
    const params = [];
    let paramIdx = 1;
    for (let i = 0; i < BATCH_SIZE; i++) {
      const globalIdx = batch * BATCH_SIZE + i;
      const ts = getTimestampForIndex(globalIdx);
      const severity = getSeverityForIndex(globalIdx);
      const service = getServiceForIndex(globalIdx);
      const message = getMessageForIndex(globalIdx);
      values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
      params.push(ts, severity, service, message);
    }
    const query = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`;
    await db.query(query, params);
    if (batch % 5 === 0) {
      console.log(`Seeded batch ${batch + 1}/20`);
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Seeding completed in ${duration}s`);
}

function validateParams(req, res, next) {
  const { offset, limit, severity, q } = req.query;
  if (offset !== undefined) {
    const o = parseInt(offset, 10);
    if (isNaN(o) || o < 0) {
      return res.status(400).json({ error: 'Invalid offset' });
    }
  }
  if (limit !== undefined) {
    const l = parseInt(limit, 10);
    if (isNaN(l) || l < 1 || l > 200) {
      return res.status(400).json({ error: 'Invalid limit (1-200)' });
    }
  }
  if (severity !== undefined && severity !== '' && !SEVERITIES.includes(severity)) {
    return res.status(400).json({ error: 'Invalid severity' });
  }
  next();
}

app.get('/api/logs', validateParams, async (req, res) => {
  try {
    const offset = parseInt(req.query.offset || '0', 10);
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 200);
    const severity = req.query.severity || '';
    const q = req.query.q || '';

    let whereClauses = [];
    let params = [];
    let paramIdx = 1;

    if (severity) {
      whereClauses.push(`severity = $${paramIdx++}`);
      params.push(severity);
    }
    if (q) {
      whereClauses.push(`message ILIKE $${paramIdx++}`);
      params.push(`%${q}%`);
    }

    const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Total count
    const countQuery = `SELECT COUNT(*) as total FROM logs ${where}`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].total, 10);

    // Rows with window
    const dataParams = [...params];
    dataParams.push(limit, offset);
    const dataQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${where}
      ORDER BY ts DESC, id DESC
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    const dataRes = await db.query(dataQuery, dataParams);

    res.json({ total, rows: dataRes.rows });
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
    sevRes.rows.forEach(r => {
      perSeverity[r.severity] = parseInt(r.count, 10);
    });

    res.json({ total, perSeverity });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);