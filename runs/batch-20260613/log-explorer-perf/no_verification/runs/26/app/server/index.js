import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

let db;

const SERVICES = ['api', 'auth', 'db', 'cache', 'worker', 'frontend', 'gateway', 'scheduler'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_WEIGHTS = [0.60, 0.25, 0.10, 0.05];

const MESSAGE_TEMPLATES = [
  'Request processed successfully for user {id}',
  'Failed to connect to {service} at {time}',
  'Cache miss for key {key}',
  'Query executed in {ms}ms',
  'Authentication {result} for {user}',
  'Worker {id} completed task {task}',
  'Gateway received {count} requests',
  'Scheduler started job {job}',
  'Database connection {status}',
  'Frontend rendered page {page}'
];

function seededRandom(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function generateLogEntry(index) {
  const seed = index * 12345 + 67890;
  const ts = new Date(Date.now() - (30 * 24 * 60 * 60 * 1000 * seededRandom(seed + 1)) - (index * 1000));
  const sevRand = seededRandom(seed + 2);
  let cum = 0;
  let severity = SEVERITIES[0];
  for (let i = 0; i < SEVERITIES.length; i++) {
    cum += SEVERITY_WEIGHTS[i];
    if (sevRand <= cum) {
      severity = SEVERITIES[i];
      break;
    }
  }
  const service = SERVICES[Math.floor(seededRandom(seed + 3) * SERVICES.length)];
  const template = MESSAGE_TEMPLATES[Math.floor(seededRandom(seed + 4) * MESSAGE_TEMPLATES.length)];
  const message = template
    .replace('{id}', Math.floor(seededRandom(seed + 5) * 10000))
    .replace('{service}', SERVICES[Math.floor(seededRandom(seed + 6) * SERVICES.length)])
    .replace('{time}', new Date(ts.getTime() - 10000).toISOString())
    .replace('{key}', 'key_' + Math.floor(seededRandom(seed + 7) * 100000))
    .replace('{ms}', Math.floor(seededRandom(seed + 8) * 500))
    .replace('{result}', seededRandom(seed + 9) > 0.1 ? 'succeeded' : 'failed')
    .replace('{user}', 'user_' + Math.floor(seededRandom(seed + 10) * 1000))
    .replace('{task}', 'task_' + Math.floor(seededRandom(seed + 11) * 100))
    .replace('{count}', Math.floor(seededRandom(seed + 12) * 1000))
    .replace('{job}', 'job_' + Math.floor(seededRandom(seed + 13) * 50))
    .replace('{status}', seededRandom(seed + 14) > 0.05 ? 'established' : 'lost')
    .replace('{page}', '/page/' + Math.floor(seededRandom(seed + 15) * 20));
  return { ts, severity, service, message };
}

async function initDb() {
  const dbPath = join(__dirname, 'logs.db');
  const exists = fs.existsSync(dbPath);
  db = new PGlite(`file://${dbPath}`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);

  const countRes = await db.query('SELECT COUNT(*) as count FROM logs');
  const rowCount = parseInt(countRes.rows[0].count);

  if (rowCount === 0) {
    console.log('Seeding 100,000 log entries...');
    const BATCH_SIZE = 1000;
    const TOTAL_ROWS = 100000;

    for (let batch = 0; batch < TOTAL_ROWS / BATCH_SIZE; batch++) {
      const values = [];
      const params = [];
      let paramIndex = 1;

      for (let i = 0; i < BATCH_SIZE; i++) {
        const idx = batch * BATCH_SIZE + i;
        const entry = generateLogEntry(idx);
        values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
        params.push(entry.ts.toISOString(), entry.severity, entry.service, entry.message);
      }

      const query = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`;
      await db.query(query, params);
      if (batch % 10 === 0) {
        console.log(`Seeded ${ (batch + 1) * BATCH_SIZE } rows...`);
      }
    }
    console.log('Seeding complete.');
  } else {
    console.log(`Database already has ${rowCount} rows, skipping seed.`);
  }

  // Create indexes
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_message ON logs (message);');

  console.log('Indexes created.');
}

app.get('/api/logs', async (req, res) => {
  try {
    const offset = parseInt(req.query.offset) || 0;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const severity = req.query.severity;
    const q = req.query.q;

    if (offset < 0 || limit < 1 || (severity && !['debug', 'info', 'warn', 'error'].includes(severity))) {
      return res.status(400).json({ error: 'Invalid parameters' });
    }

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

    const countQuery = `SELECT COUNT(*) as total FROM logs ${where}`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].total);

    const dataQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${where}
      ORDER BY ts DESC 
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
    params.push(limit, offset);

    const dataRes = await db.query(dataQuery, params);

    res.json({ total, rows: dataRes.rows });
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
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);