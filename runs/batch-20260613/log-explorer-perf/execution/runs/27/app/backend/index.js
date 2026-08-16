const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

let db;
let isSeeded = false;

const SERVICES = ['api', 'auth', 'db', 'worker', 'frontend', 'cache', 'queue', 'monitor'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_WEIGHTS = [0.6, 0.25, 0.1, 0.05]; // cumulative for distribution

const MESSAGE_TEMPLATES = [
  'User {user} logged in from {ip}',
  'Request to {endpoint} completed in {time}ms',
  'Database query {query} returned {rows} rows',
  'Cache {action} for key {key}',
  'Background job {job} {status}',
  'Error processing {entity}: {detail}',
  'Service {service} started successfully',
  'Connection {action} to {target}'
];

const FRAGMENTS = {
  user: ['alice', 'bob', 'charlie', 'diana', 'eve'],
  ip: ['192.168.1.1', '10.0.0.5', '172.16.0.10', '8.8.8.8'],
  endpoint: ['/users', '/orders', '/products', '/login', '/api/v1/data'],
  time: ['12', '45', '120', '300', '890'],
  query: ['SELECT * FROM users', 'UPDATE orders SET status', 'INSERT INTO logs'],
  rows: ['10', '42', '100', '0'],
  action: ['hit', 'miss', 'evict', 'set'],
  key: ['user:123', 'session:abc', 'product:xyz'],
  job: ['email', 'report', 'cleanup', 'sync'],
  status: ['started', 'completed', 'failed', 'retrying'],
  entity: ['payment', 'order', 'user', 'inventory'],
  detail: ['timeout', 'invalid input', 'not found', 'permission denied'],
  service: SERVICES,
  target: ['primary-db', 'replica', 'redis', 'elasticsearch']
};

function seededRandom(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function generateDeterministicLog(index) {
  const seed = index;
  const ts = new Date(Date.now() - (30 * 24 * 60 * 60 * 1000) * (1 - (index / 100000)) + (seededRandom(seed * 2) * 1000 * 60 * 60 * 24 * 30 * (index % 100) / 100)).toISOString();
  
  // Severity distribution
  const rand = seededRandom(seed * 3);
  let severity;
  if (rand < SEVERITY_WEIGHTS[0]) severity = 'debug';
  else if (rand < SEVERITY_WEIGHTS[0] + SEVERITY_WEIGHTS[1]) severity = 'info';
  else if (rand < SEVERITY_WEIGHTS[0] + SEVERITY_WEIGHTS[1] + SEVERITY_WEIGHTS[2]) severity = 'warn';
  else severity = 'error';

  const service = SERVICES[Math.floor(seededRandom(seed * 4) * SERVICES.length)];
  
  // Generate message
  const template = MESSAGE_TEMPLATES[Math.floor(seededRandom(seed * 5) * MESSAGE_TEMPLATES.length)];
  let message = template;
  Object.keys(FRAGMENTS).forEach(key => {
    const regex = new RegExp(`\\{${key}\\}`, 'g');
    const values = FRAGMENTS[key];
    const value = values[Math.floor(seededRandom(seed * (6 + key.length)) * values.length)];
    message = message.replace(regex, value);
  });

  return {
    id: index + 1,
    ts,
    severity,
    service,
    message
  };
}

async function initializeDatabase() {
  console.log('Initializing PGlite...');
  db = new PGlite('./.pglite');
  await db.waitReady;
  console.log('PGlite ready');

  // Create table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);

  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*) as count FROM logs');
  const count = parseInt(countResult.rows[0].count);
  
  if (count === 100000) {
    console.log('Database already seeded with 100,000 rows');
    isSeeded = true;
  } else if (count > 0) {
    console.log(`Found ${count} rows, reseeding...`);
    await db.exec('DELETE FROM logs');
    await seedDatabase();
  } else {
    await seedDatabase();
  }

  // Create indexes
  console.log('Creating indexes...');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_message ON logs USING gin (to_tsvector(\'english\', message));'); // for text search, but we'll use LIKE for simplicity
  // Actually for substring, better to use trigram or just LIKE with index, but for perf, perhaps btree on lower or just rely on ts index + filter
  // For simplicity and perf on 100k, even without perfect index it's fast, but let's add
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_message_lower ON logs (lower(message));');

  console.log('Indexes created');
}

async function seedDatabase() {
  console.log('Seeding 100,000 log entries...');
  const BATCH_SIZE = 5000;
  const total = 100000;

  await db.exec('BEGIN');
  for (let batch = 0; batch < total / BATCH_SIZE; batch++) {
    const start = batch * BATCH_SIZE;
    const values = [];
    const params = [];
    let paramIndex = 1;

    for (let i = 0; i < BATCH_SIZE && (start + i) < total; i++) {
      const log = generateDeterministicLog(start + i);
      values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
      params.push(log.id, log.ts, log.severity, log.service, log.message);
    }

    if (values.length > 0) {
      const query = `INSERT INTO logs (id, ts, severity, service, message) VALUES ${values.join(', ')}`;
      await db.query(query, params);
    }
    
    if ((batch + 1) % 5 === 0) {
      console.log(`Seeded ${Math.min((batch + 1) * BATCH_SIZE, total)} rows...`);
    }
  }
  await db.exec('COMMIT');

  console.log('Seeding complete!');
  isSeeded = true;
}

function validateParams(req, res, next) {
  const { offset, limit, severity } = req.query;
  
  if (offset !== undefined) {
    const off = parseInt(offset);
    if (isNaN(off) || off < 0) {
      return res.status(400).json({ error: 'Invalid offset: must be non-negative integer' });
    }
  }
  
  if (limit !== undefined) {
    const lim = parseInt(limit);
    if (isNaN(lim) || lim < 1 || lim > 200) {
      return res.status(400).json({ error: 'Invalid limit: must be between 1 and 200' });
    }
  }
  
  if (severity !== undefined && severity !== '') {
    if (!SEVERITIES.includes(severity)) {
      return res.status(400).json({ error: 'Invalid severity: must be one of debug, info, warn, error' });
    }
  }
  
  next();
}

app.get('/api/logs', validateParams, async (req, res) => {
  try {
    const offset = parseInt(req.query.offset) || 0;
    const limit = Math.min(parseInt(req.query.limit) || 100, 200);
    const severity = req.query.severity || '';
    const q = req.query.q || '';

    let whereClauses = [];
    let params = [];
    let paramIndex = 1;

    if (severity) {
      whereClauses.push(`severity = $${paramIndex++}`);
      params.push(severity);
    }

    if (q) {
      whereClauses.push(`lower(message) LIKE $${paramIndex++}`);
      params.push(`%${q.toLowerCase()}%`);
    }

    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM logs ${where}`;
    const countResult = await db.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total);

    // Get rows
    const dataQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${where}
      ORDER BY ts DESC 
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
    params.push(limit, offset);

    const dataResult = await db.query(dataQuery, params);

    res.json({
      total,
      rows: dataResult.rows
    });
  } catch (error) {
    console.error('Error fetching logs:', error);
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

    const perSeverity = {};
    SEVERITIES.forEach(s => perSeverity[s] = 0);
    severityResult.rows.forEach(row => {
      perSeverity[row.severity] = parseInt(row.count);
    });

    res.json({ total, perSeverity });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function startServer() {
  await initializeDatabase();
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);