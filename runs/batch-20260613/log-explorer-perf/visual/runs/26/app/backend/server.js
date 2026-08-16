import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

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
  'Cache miss for key {key}',
  'Processing job {jobId} with status {status}',
  'Error connecting to service {service}: {error}',
  'Warning: high memory usage detected {usage}%',
  'Debug: variable {var} set to {value}',
  'Authentication failed for user {user}',
  'File {file} uploaded successfully',
];

function seededRandom(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function generateDeterministicLog(index) {
  const seed = index;
  const ts = new Date(Date.now() - (100000 - index) * 25920); // spread over ~30 days, deterministic
  // better: 30 days = 2.592e9 ms, 100k rows -> ~25.92s per row
  const baseTime = new Date('2024-01-01T00:00:00Z').getTime();
  const tsDate = new Date(baseTime + (index * 25920)); // ~30 days span

  const rand = seededRandom(seed);
  let severity;
  const cum = SEVERITY_WEIGHTS;
  if (rand < cum[0]) severity = 'debug';
  else if (rand < cum[0] + cum[1]) severity = 'info';
  else if (rand < cum[0] + cum[1] + cum[2]) severity = 'warn';
  else severity = 'error';

  const service = SERVICES[index % SERVICES.length];
  const template = MESSAGE_TEMPLATES[index % MESSAGE_TEMPLATES.length];
  const message = template
    .replace('{user}', `user${(index % 1000)}`)
    .replace('{ip}', `192.168.1.${(index % 255)}`)
    .replace('{endpoint}', `/api/v1/resource${(index % 50)}`)
    .replace('{time}', String(10 + (index % 500)))
    .replace('{rows}', String(1 + (index % 1000)))
    .replace('{query}', `SELECT * FROM table${(index % 20)}`)
    .replace('{key}', `cache-key-${(index % 10000)}`)
    .replace('{jobId}', `job-${(index % 5000)}`)
    .replace('{status}', ['pending', 'running', 'completed', 'failed'][index % 4])
    .replace('{service}', SERVICES[(index + 3) % SERVICES.length])
    .replace('{error}', ['timeout', 'connection refused', 'auth failed'][index % 3])
    .replace('{usage}', String(70 + (index % 30)))
    .replace('{var}', `var${(index % 20)}`)
    .replace('{value}', String(index % 100))
    .replace('{file}', `upload-${(index % 1000)}.log`);

  return {
    ts: tsDate.toISOString(),
    severity,
    service,
    message
  };
}

async function initDb() {
  db = new PGlite({ dataDir: 'file://./.pglite' });
  await db.waitReady;

  // Create table
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
  const count = parseInt(countRes.rows[0].count);
  if (count === 100000) {
    isSeeded = true;
    console.log('Database already seeded with 100,000 rows.');
  } else if (count > 0) {
    console.log(`Found ${count} rows, reseeding...`);
    await db.exec('TRUNCATE logs;');
    await seedDatabase();
  } else {
    await seedDatabase();
  }

  // Create indexes
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);');
  // For message search, a simple index won't help ILIKE much, but for demo ok. Could add trigram but keep deps minimal.
  console.log('Indexes created.');
}

async function seedDatabase() {
  console.log('Seeding 100,000 log entries...');
  const BATCH_SIZE = 1000;
  const total = 100000;

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = [];
    for (let j = 0; j < BATCH_SIZE && (i + j) < total; j++) {
      const log = generateDeterministicLog(i + j);
      batch.push(`('${log.ts}', '${log.severity}', '${log.service}', '${log.message.replace(/'/g, "''")}')`);
    }
    const values = batch.join(',');
    await db.exec(`
      INSERT INTO logs (ts, severity, service, message) 
      VALUES ${values};
    `);
    if ((i + BATCH_SIZE) % 10000 === 0) {
      console.log(`Seeded ${i + BATCH_SIZE} rows...`);
    }
  }
  isSeeded = true;
  console.log('Seeding complete.');
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
  if (severity && !['debug', 'info', 'warn', 'error'].includes(severity)) {
    res.status(400).json({ error: 'Invalid severity' });
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
    let paramIndex = 1;

    if (severity) {
      whereClauses.push(`severity = $${paramIndex++}`);
      queryParams.push(severity);
    }
    if (q) {
      whereClauses.push(`message ILIKE $${paramIndex++}`);
      queryParams.push(`%${q}%`);
    }

    const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Total count
    const countQuery = `SELECT COUNT(*) as total FROM logs ${where}`;
    const countRes = await db.query(countQuery, queryParams);
    const total = parseInt(countRes.rows[0].total);

    // Rows with window
    const dataQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${where}
      ORDER BY ts DESC, id DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
    const dataParams = [...queryParams, limit, offset];
    const dataRes = await db.query(dataQuery, dataParams);

    res.json({
      total,
      rows: dataRes.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
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
    sevRes.rows.forEach(row => {
      perSeverity[row.severity] = parseInt(row.count);
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
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);