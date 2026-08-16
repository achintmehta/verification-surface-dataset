import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

let db;

const SERVICES = ['auth', 'payment', 'user', 'order', 'inventory', 'notification', 'analytics', 'gateway'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_WEIGHTS = [0.60, 0.25, 0.10, 0.05];
const MESSAGE_TEMPLATES = [
  'User {id} logged in from {ip}',
  'Payment {amount} processed for order {oid}',
  'Failed to connect to {service} service',
  'Cache miss for key {key}',
  'Request {reqid} completed in {ms}ms',
  'Database query took {ms}ms on table {table}',
  'Sending notification to user {id}',
  'Inventory updated: {item} now at {qty}',
  'Auth token expired for session {sid}',
  'Analytics event {event} tracked'
];

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

async function initDb() {
  db = new PGlite(join(DATA_DIR, 'pglite'));
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);

  // Create indexes
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_message ON logs (message);`);

  const countRes = await db.query('SELECT COUNT(*) as count FROM logs');
  const count = parseInt(countRes.rows[0].count, 10);

  if (count === 0) {
    console.log('Seeding 100,000 log entries...');
    await seedLogs();
    console.log('Seeding complete.');
  } else {
    console.log(`Database already seeded with ${count} rows.`);
  }
}

async function seedLogs() {
  const TOTAL_ROWS = 100000;
  const BATCH_SIZE = 5000;
  const START_DATE = new Date('2024-01-01T00:00:00Z').getTime();
  const END_DATE = new Date('2024-01-31T23:59:59Z').getTime();
  const TIME_SPAN = END_DATE - START_DATE;

  const rand = seededRandom(42); // deterministic seed

  let inserted = 0;
  for (let batch = 0; batch < TOTAL_ROWS / BATCH_SIZE; batch++) {
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (let i = 0; i < BATCH_SIZE && inserted < TOTAL_ROWS; i++, inserted++) {
      const progress = inserted / TOTAL_ROWS;
      const ts = new Date(START_DATE + Math.floor(progress * TIME_SPAN + (rand() - 0.5) * 100000));

      // weighted severity
      let r = rand();
      let severity = SEVERITIES[0];
      let cum = 0;
      for (let j = 0; j < SEVERITIES.length; j++) {
        cum += SEVERITY_WEIGHTS[j];
        if (r <= cum) {
          severity = SEVERITIES[j];
          break;
        }
      }

      const service = SERVICES[Math.floor(rand() * SERVICES.length)];

      // pick template and fill
      const template = MESSAGE_TEMPLATES[Math.floor(rand() * MESSAGE_TEMPLATES.length)];
      const message = template
        .replace('{id}', Math.floor(rand() * 10000))
        .replace('{ip}', `${Math.floor(rand()*255)}.${Math.floor(rand()*255)}.${Math.floor(rand()*255)}.${Math.floor(rand()*255)}`)
        .replace('{amount}', (rand() * 1000).toFixed(2))
        .replace('{oid}', 'ORD-' + Math.floor(rand() * 100000))
        .replace('{service}', SERVICES[Math.floor(rand() * SERVICES.length)])
        .replace('{key}', 'cache-' + Math.floor(rand() * 100000))
        .replace('{reqid}', 'REQ-' + Math.floor(rand() * 1000000))
        .replace('{ms}', Math.floor(rand() * 500))
        .replace('{table}', ['users', 'orders', 'logs'][Math.floor(rand()*3)])
        .replace('{sid}', 'sess-' + Math.floor(rand()*100000))
        .replace('{item}', 'SKU-' + Math.floor(rand()*500))
        .replace('{qty}', Math.floor(rand()*100))
        .replace('{event}', ['click', 'view', 'purchase', 'login'][Math.floor(rand()*4)]);

      values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
      params.push(ts.toISOString(), severity, service, message);
    }

    const query = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`;
    await db.query(query, params);
    if (batch % 4 === 0) {
      console.log(`Seeded ${inserted} rows...`);
    }
  }
}

function validateParams(req, res) {
  const { offset = '0', limit = '50', severity, q } = req.query;

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
    res.status(400).json({ error: 'Invalid severity' });
    return null;
  }

  return { offset: off, limit: lim, severity, q: q || null };
}

app.get('/api/logs', async (req, res) => {
  const params = validateParams(req, res);
  if (!params) return;

  const { offset, limit, severity, q } = params;

  let where = 'WHERE 1=1';
  const queryParams = [];
  let idx = 1;

  if (severity) {
    where += ` AND severity = $${idx++}`;
    queryParams.push(severity);
  }
  if (q) {
    where += ` AND message ILIKE $${idx++}`;
    queryParams.push(`%${q}%`);
  }

  // total count
  const countQuery = `SELECT COUNT(*) as total FROM logs ${where}`;
  const countRes = await db.query(countQuery, queryParams);
  const total = parseInt(countRes.rows[0].total, 10);

  // rows
  const dataQuery = `
    SELECT id, ts, severity, service, message 
    FROM logs 
    ${where}
    ORDER BY ts DESC 
    LIMIT $${idx++} OFFSET $${idx++}
  `;
  queryParams.push(limit, offset);

  const dataRes = await db.query(dataQuery, queryParams);

  res.json({
    total,
    rows: dataRes.rows
  });
});

app.get('/api/stats', async (req, res) => {
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
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);