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

let db = null;

const SERVICES = ['auth', 'api', 'db', 'frontend', 'worker', 'scheduler', 'cache', 'gateway'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_WEIGHTS = [0.60, 0.25, 0.10, 0.05];
const MESSAGE_TEMPLATES = [
  'User {userId} logged in from {ip}',
  'Request to {endpoint} completed in {ms}ms',
  'Database query {query} returned {rows} rows',
  'Cache {action} for key {key}',
  'Scheduled job {job} started',
  'Error processing request: {error}',
  'Connection from {ip} established',
  'Message published to topic {topic}',
  'Health check passed for service {service}',
  'Configuration reloaded from {source}'
];

function seededRandom(seed) {
  let x = seed;
  return () => {
    x = (x * 16807) % 2147483647;
    return x / 2147483647;
  };
}

function generateLogs(count) {
  const logs = [];
  const rand = seededRandom(42);
  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  for (let i = 0; i < count; i++) {
    const r = rand();
    let severity;
    let cum = 0;
    for (let j = 0; j < SEVERITIES.length; j++) {
      cum += SEVERITY_WEIGHTS[j];
      if (r < cum) {
        severity = SEVERITIES[j];
        break;
      }
    }

    const service = SERVICES[Math.floor(rand() * SERVICES.length)];
    const ts = new Date(now - Math.floor(rand() * thirtyDaysMs)).toISOString();

    const template = MESSAGE_TEMPLATES[Math.floor(rand() * MESSAGE_TEMPLATES.length)];
    const message = template
      .replace('{userId}', Math.floor(rand() * 10000))
      .replace('{ip}', `${Math.floor(rand()*255)}.${Math.floor(rand()*255)}.${Math.floor(rand()*255)}.${Math.floor(rand()*255)}`)
      .replace('{endpoint}', ['/users', '/orders', '/products', '/auth'][Math.floor(rand()*4)])
      .replace('{ms}', Math.floor(rand() * 500))
      .replace('{rows}', Math.floor(rand() * 1000))
      .replace('{query}', ['SELECT *', 'UPDATE', 'INSERT'][Math.floor(rand()*3)])
      .replace('{action}', ['hit', 'miss', 'evict'][Math.floor(rand()*3)])
      .replace('{key}', `key_${Math.floor(rand()*1000)}`)
      .replace('{job}', ['cleanup', 'report', 'sync'][Math.floor(rand()*3)])
      .replace('{error}', ['timeout', 'not found', 'invalid'][Math.floor(rand()*3)])
      .replace('{topic}', ['logs', 'events', 'metrics'][Math.floor(rand()*3)])
      .replace('{service}', service)
      .replace('{source}', ['env', 'file', 'remote'][Math.floor(rand()*3)]);

    logs.push({
      id: i + 1,
      ts,
      severity,
      service,
      message
    });
  }
  // Sort by ts desc for determinism? but we'll order in query
  return logs;
}

async function initDb() {
  console.log('Initializing PGlite...');
  db = new PGlite({ dataDir: DATA_DIR });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);

  const countRes = await db.query('SELECT COUNT(*) as count FROM logs');
  const count = parseInt(countRes.rows[0].count);

  if (count === 0) {
    console.log('Seeding 100,000 log entries...');
    const start = Date.now();
    const logs = generateLogs(100000);

    // Batch insert
    const BATCH_SIZE = 5000;
    for (let i = 0; i < logs.length; i += BATCH_SIZE) {
      const batch = logs.slice(i, i + BATCH_SIZE);
      const values = batch.map(l => `(${l.id}, '${l.ts}', '${l.severity}', '${l.service}', '${l.message.replace(/'/g, "''")}')`).join(',');
      await db.exec(`
        INSERT INTO logs (id, ts, severity, service, message) VALUES ${values};
      `);
      if (i % 20000 === 0) {
        console.log(`Seeded ${i + batch.length} rows...`);
      }
    }
    console.log(`Seeding completed in ${Date.now() - start}ms`);

    // Create indexes after seeding
    console.log('Creating indexes...');
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);
      CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);
    `);
    console.log('Indexes created.');
  } else {
    console.log(`Database already seeded with ${count} rows.`);
  }
}

app.get('/api/logs', async (req, res) => {
  try {
    const offset = parseInt(req.query.offset) || 0;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const severity = req.query.severity;
    const q = req.query.q;

    if (offset < 0 || limit < 1) {
      return res.status(400).json({ error: 'Invalid offset or limit' });
    }

    const validSeverities = ['debug', 'info', 'warn', 'error'];
    if (severity && !validSeverities.includes(severity)) {
      return res.status(400).json({ error: 'Invalid severity' });
    }

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

    // Count total
    const countQuery = `SELECT COUNT(*) as total FROM logs ${where}`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].total);

    // Get rows - use ts DESC
    const dataQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${where}
      ORDER BY ts DESC 
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    params.push(limit, offset);

    const dataRes = await db.query(dataQuery, params);

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
    const bySeverity = {};
    SEVERITIES.forEach(s => bySeverity[s] = 0);
    sevRes.rows.forEach(r => {
      bySeverity[r.severity] = parseInt(r.count);
    });

    res.json({ total, bySeverity });
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