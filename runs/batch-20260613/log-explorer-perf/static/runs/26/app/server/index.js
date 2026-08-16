import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

let db;

const SERVICES = ['api', 'auth', 'db', 'worker', 'frontend', 'cache', 'queue', 'gateway'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_WEIGHTS = [0.60, 0.25, 0.10, 0.05];
const MESSAGE_TEMPLATES = [
  'User {id} logged in from {ip}',
  'Query executed in {time}ms for table {table}',
  'Cache miss for key {key}',
  'Request to {endpoint} returned {status}',
  'Background job {job} completed with {result}',
  'Connection from {ip} closed after {duration}s',
  'Error processing message {msgId}: {reason}',
  'Metric {metric} recorded value {value}'
];

function seededRandom(seed) {
  let x = seed;
  return () => {
    x = (x * 16807) % 2147483647;
    return x / 2147483647;
  };
}

function pickWeighted(rand, weights) {
  const r = rand();
  let cum = 0;
  for (let i = 0; i < weights.length; i++) {
    cum += weights[i];
    if (r <= cum) return i;
  }
  return weights.length - 1;
}

function generateMessage(rand, idx) {
  const tpl = MESSAGE_TEMPLATES[idx % MESSAGE_TEMPLATES.length];
  return tpl
    .replace('{id}', Math.floor(rand() * 10000))
    .replace('{ip}', `${Math.floor(rand()*256)}.${Math.floor(rand()*256)}.${Math.floor(rand()*256)}.${Math.floor(rand()*256)}`)
    .replace('{time}', Math.floor(rand() * 500 + 1))
    .replace('{table}', ['users', 'orders', 'logs', 'events'][Math.floor(rand()*4)])
    .replace('{key}', 'cache:' + Math.floor(rand() * 100000))
    .replace('{endpoint}', ['/api/users', '/api/orders', '/health', '/metrics'][Math.floor(rand()*4)])
    .replace('{status}', [200, 201, 400, 404, 500][Math.floor(rand()*5)])
    .replace('{job}', ['sync', 'cleanup', 'report', 'index'][Math.floor(rand()*4)])
    .replace('{result}', ['success', 'partial', 'failed'][Math.floor(rand()*3)])
    .replace('{duration}', (rand() * 300 + 10).toFixed(1))
    .replace('{msgId}', Math.floor(rand() * 1000000))
    .replace('{reason}', ['timeout', 'invalid', 'notfound', 'rate-limit'][Math.floor(rand()*4)])
    .replace('{metric}', ['cpu', 'mem', 'disk', 'net'][Math.floor(rand()*4)])
    .replace('{value}', Math.floor(rand() * 100));
}

async function seedDatabase() {
  console.log('Checking if database needs seeding...');
  const countRes = await db.query('SELECT COUNT(*) as count FROM logs');
  const count = parseInt(countRes.rows[0].count);
  if (count >= 100000) {
    console.log(`Database already has ${count} rows, skipping seed.`);
    return;
  }

  console.log('Seeding 100,000 log entries...');
  await db.query('DELETE FROM logs'); // clean if partial

  const BATCH_SIZE = 1000;
  const TOTAL = 100000;
  const START_TS = new Date('2024-01-01T00:00:00Z').getTime();
  const END_TS = new Date('2024-01-31T00:00:00Z').getTime();
  const TIME_SPAN = END_TS - START_TS;

  const rand = seededRandom(42); // deterministic seed

  for (let batch = 0; batch < TOTAL / BATCH_SIZE; batch++) {
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (let i = 0; i < BATCH_SIZE; i++) {
      const globalIdx = batch * BATCH_SIZE + i;
      const ts = new Date(START_TS + Math.floor((globalIdx / TOTAL) * TIME_SPAN) + Math.floor(rand() * 1000));
      const sevIdx = pickWeighted(rand, SEVERITY_WEIGHTS);
      const severity = SEVERITIES[sevIdx];
      const service = SERVICES[globalIdx % SERVICES.length];
      const message = generateMessage(rand, globalIdx);

      values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
      params.push(globalIdx, ts.toISOString(), severity, service, message);
    }

    const query = `INSERT INTO logs (id, ts, severity, service, message) VALUES ${values.join(', ')}`;
    await db.query(query, params);
    if (batch % 10 === 0) {
      console.log(`Seeded batch ${batch + 1}/${TOTAL / BATCH_SIZE}`);
    }
  }
  console.log('Seeding complete.');
}

async function initializeDatabase() {
  db = new PGlite('./pglite-data');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);

  // Indexes for performance
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_message ON logs (message);`); // for substring, though not perfect for ILIKE

  await seedDatabase();
}

function validateParams(req, res) {
  const { offset, limit, severity, q } = req.query;
  if (offset !== undefined) {
    const o = parseInt(offset);
    if (isNaN(o) || o < 0) {
      res.status(400).json({ error: 'Invalid offset' });
      return false;
    }
  }
  if (limit !== undefined) {
    const l = parseInt(limit);
    if (isNaN(l) || l < 1 || l > 200) {
      res.status(400).json({ error: 'Invalid limit (1-200)' });
      return false;
    }
  }
  if (severity !== undefined && severity !== '' && !['debug', 'info', 'warn', 'error'].includes(severity)) {
    res.status(400).json({ error: 'Invalid severity' });
    return false;
  }
  return true;
}

app.get('/api/logs', async (req, res) => {
  if (!validateParams(req, res)) return;

  const offset = parseInt(req.query.offset || '0');
  const limit = Math.min(parseInt(req.query.limit || '100'), 200);
  const severity = req.query.severity || '';
  const q = req.query.q || '';

  let where = 'WHERE 1=1';
  const params = [];
  let paramIdx = 1;

  if (severity) {
    where += ` AND severity = $${paramIdx++}`;
    params.push(severity);
  }
  if (q) {
    where += ` AND message ILIKE $${paramIdx++}`;
    params.push(`%${q}%`);
  }

  try {
    // Total count
    const countQuery = `SELECT COUNT(*) as total FROM logs ${where}`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].total);

    // Rows
    const dataQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${where} 
      ORDER BY ts DESC 
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    params.push(limit, offset);
    const dataRes = await db.query(dataQuery, params);

    res.json({ total, rows: dataRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Query failed' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const totalRes = await db.query('SELECT COUNT(*) as total FROM logs');
    const total = parseInt(totalRes.rows[0].total);

    const sevRes = await db.query(`
      SELECT severity, COUNT(*) as count 
      FROM logs 
      GROUP BY severity
    `);
    const perSeverity = {};
    SEVERITIES.forEach(s => perSeverity[s] = 0);
    sevRes.rows.forEach(r => {
      perSeverity[r.severity] = parseInt(r.count);
    });

    res.json({ total, perSeverity });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Stats failed' });
  }
});

async function start() {
  await initializeDatabase();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);