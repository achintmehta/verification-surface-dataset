import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.join(__dirname, 'pglite-data');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

let db = null;
let isSeeded = false;

const SERVICES = ['api', 'worker', 'db', 'auth', 'cache', 'queue', 'frontend', 'scheduler'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const MESSAGE_TEMPLATES = [
  'Request processed successfully for user {id}',
  'Failed to connect to {service} after {retries} retries',
  'Cache miss for key {key}',
  'Query executed in {time}ms',
  'User {id} logged in from {ip}',
  'Background job {job} completed',
  'Error: {error} occurred in module {module}',
  'Timeout waiting for response from {service}',
  'Data validation passed for record {id}',
  'Scheduled task {task} started'
];

function generateDeterministicLog(index) {
  // Deterministic based on index
  const seed = index * 123456789;
  const ts = new Date(Date.now() - (index % (30 * 24 * 3600 * 1000)) - (seed % 100000)); // span ~30 days
  const severity = SEVERITIES[seed % SEVERITIES.length];
  // Distribute roughly 60/25/10/5 : debug 60%, info 25%, warn 10%, error 5%
  let sevIndex;
  const mod = seed % 100;
  if (mod < 60) sevIndex = 0; // debug
  else if (mod < 85) sevIndex = 1; // info
  else if (mod < 95) sevIndex = 2; // warn
  else sevIndex = 3; // error
  const severityFinal = SEVERITIES[sevIndex];
  const service = SERVICES[seed % SERVICES.length];
  const template = MESSAGE_TEMPLATES[seed % MESSAGE_TEMPLATES.length];
  const message = template
    .replace('{id}', (seed % 10000).toString())
    .replace('{service}', SERVICES[(seed + 1) % SERVICES.length])
    .replace('{retries}', ((seed % 5) + 1).toString())
    .replace('{key}', 'key-' + (seed % 100000))
    .replace('{time}', (seed % 500).toString())
    .replace('{ip}', `192.168.1.${seed % 255}`)
    .replace('{job}', 'job-' + (seed % 1000))
    .replace('{error}', ['timeout', 'connection', 'parse', 'auth'][seed % 4])
    .replace('{module}', ['auth', 'db', 'net', 'ui'][seed % 4])
    .replace('{task}', 'task-' + (seed % 500));

  return {
    ts: ts.toISOString(),
    severity: severityFinal,
    service,
    message
  };
}

async function initDb() {
  console.log('Initializing PGLite...');
  db = new PGlite(DB_DIR);

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
  console.log(`Existing rows: ${count}`);

  if (count >= 100000) {
    console.log('Database already seeded with 100k+ rows. Skipping seed.');
    isSeeded = true;
    await createIndexes();
    return;
  }

  console.log('Seeding 100,000 deterministic log entries...');
  const startTime = Date.now();

  // Batch insert
  const BATCH_SIZE = 1000;
  const TOTAL = 100000;

  for (let batchStart = 0; batchStart < TOTAL; batchStart += BATCH_SIZE) {
    const batch = [];
    for (let i = 0; i < BATCH_SIZE && (batchStart + i) < TOTAL; i++) {
      const log = generateDeterministicLog(batchStart + i);
      batch.push(log);
    }

    const values = batch.map((log, idx) => {
      return `($${idx*4 + 1}, $${idx*4 + 2}, $${idx*4 + 3}, $${idx*4 + 4})`;
    }).join(',');

    const params = [];
    batch.forEach(log => {
      params.push(log.ts, log.severity, log.service, log.message);
    });

    await db.query(
      `INSERT INTO logs (ts, severity, service, message) VALUES ${values}`,
      params
    );

    if (batchStart % 10000 === 0) {
      console.log(`Seeded ${batchStart + batch.length} rows...`);
    }
  }

  const seedTime = Date.now() - startTime;
  console.log(`Seeding completed in ${seedTime}ms`);

  await createIndexes();
  isSeeded = true;
}

async function createIndexes() {
  console.log('Creating indexes...');
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_message ON logs (message text_pattern_ops);
  `);
  console.log('Indexes created.');
}

app.get('/api/stats', async (req, res) => {
  try {
    const totalRes = await db.query('SELECT COUNT(*) as total FROM logs');
    const total = parseInt(totalRes.rows[0].total);

    const sevRes = await db.query(`
      SELECT severity, COUNT(*) as count 
      FROM logs 
      GROUP BY severity
    `);

    const counts = { debug: 0, info: 0, warn: 0, error: 0 };
    sevRes.rows.forEach(r => {
      counts[r.severity] = parseInt(r.count);
    });

    res.json({
      total,
      debug: counts.debug,
      info: counts.info,
      warn: counts.warn,
      error: counts.error
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/api/logs', async (req, res) => {
  const { offset = '0', limit = '50', severity, q } = req.query;

  const offsetNum = parseInt(offset, 10);
  const limitNum = parseInt(limit, 10);

  if (isNaN(offsetNum) || offsetNum < 0) {
    return res.status(400).json({ error: 'Invalid offset' });
  }
  if (isNaN(limitNum) || limitNum < 1 || limitNum > 200) {
    return res.status(400).json({ error: 'Invalid limit (1-200)' });
  }

  if (severity && !['debug', 'info', 'warn', 'error'].includes(severity)) {
    return res.status(400).json({ error: 'Invalid severity' });
  }

  try {
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

    // Count total
    const countQuery = `SELECT COUNT(*) as total FROM logs ${where}`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].total);

    // Fetch rows - use index backed order
    const dataParams = [...params];
    dataParams.push(limitNum, offsetNum);
    const dataQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${where}
      ORDER BY ts DESC 
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    const dataRes = await db.query(dataQuery, dataParams);

    res.json({
      total,
      rows: dataRes.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);