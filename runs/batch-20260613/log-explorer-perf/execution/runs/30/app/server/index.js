const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

let db;

const SERVICES = ['api', 'auth', 'db', 'cache', 'queue', 'worker', 'frontend', 'billing'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_WEIGHTS = [0.60, 0.25, 0.10, 0.05];
const MESSAGE_TEMPLATES = [
  'User {userId} logged in from {ip}',
  'Request to {endpoint} completed in {ms}ms',
  'Database query {query} returned {rows} rows',
  'Cache {operation} for key {key} {result}',
  'Queue job {jobId} processed with status {status}',
  'Worker {workerId} started task {task}',
  'Frontend render of {component} took {time}ms',
  'Billing invoice {invoiceId} generated for {amount}'
];

function seededRandom(seed) {
  let x = Math.sin(seed++) * 10000;
  return x - Math.floor(x);
}

function getDeterministicValue(seed, max) {
  return Math.floor(seededRandom(seed) * max);
}

async function seedDatabase() {
  const countResult = await db.query('SELECT COUNT(*) as count FROM logs');
  const currentCount = parseInt(countResult.rows[0].count);
  if (currentCount >= 100000) {
    console.log(`Database already seeded with ${currentCount} rows. Skipping seed.`);
    return;
  }

  console.log('Seeding 100,000 log entries...');
  const startTime = Date.now();

  const BATCH_SIZE = 500;
  const TOTAL_ROWS = 100000;
  const START_TS = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago

  await db.query('BEGIN');

  for (let i = 0; i < TOTAL_ROWS; i += BATCH_SIZE) {
    const batch = [];
    for (let j = 0; j < BATCH_SIZE && (i + j) < TOTAL_ROWS; j++) {
      const rowNum = i + j;
      const seed = rowNum * 123456789; // deterministic seed

      // Timestamp: evenly distributed over 30 days, but with some clustering
      const tsOffset = Math.floor((rowNum / TOTAL_ROWS) * 30 * 24 * 60 * 60 * 1000) + getDeterministicValue(seed, 3600000);
      const ts = new Date(START_TS + tsOffset).toISOString();

      // Severity based on weights
      let sevRand = seededRandom(seed + 1);
      let severity = SEVERITIES[0];
      let cum = 0;
      for (let s = 0; s < SEVERITIES.length; s++) {
        cum += SEVERITY_WEIGHTS[s];
        if (sevRand <= cum) {
          severity = SEVERITIES[s];
          break;
        }
      }

      const service = SERVICES[getDeterministicValue(seed + 2, SERVICES.length)];

      // Message
      const template = MESSAGE_TEMPLATES[getDeterministicValue(seed + 3, MESSAGE_TEMPLATES.length)];
      const message = template
        .replace('{userId}', getDeterministicValue(seed + 4, 10000))
        .replace('{ip}', `192.168.${getDeterministicValue(seed + 5, 256)}.${getDeterministicValue(seed + 6, 256)}`)
        .replace('{endpoint}', `/api/v1/resource/${getDeterministicValue(seed + 7, 100)}`)
        .replace('{ms}', getDeterministicValue(seed + 8, 500))
        .replace('{query}', `SELECT * FROM table_${getDeterministicValue(seed + 9, 20)}`)
        .replace('{rows}', getDeterministicValue(seed + 10, 1000))
        .replace('{operation}', ['hit', 'miss', 'set', 'evict'][getDeterministicValue(seed + 11, 4)])
        .replace('{key}', `key_${getDeterministicValue(seed + 12, 100000)}`)
        .replace('{result}', ['success', 'failed', 'timeout'][getDeterministicValue(seed + 13, 3)])
        .replace('{jobId}', `job-${getDeterministicValue(seed + 14, 100000)}`)
        .replace('{status}', ['completed', 'failed', 'retry'][getDeterministicValue(seed + 15, 3)])
        .replace('{workerId}', `worker-${getDeterministicValue(seed + 16, 50)}`)
        .replace('{task}', `task-${getDeterministicValue(seed + 17, 1000)}`)
        .replace('{component}', ['Dashboard', 'Table', 'Modal', 'Chart'][getDeterministicValue(seed + 18, 4)])
        .replace('{time}', getDeterministicValue(seed + 19, 200))
        .replace('{invoiceId}', `INV-${getDeterministicValue(seed + 20, 100000)}`)
        .replace('{amount}', (getDeterministicValue(seed + 21, 10000) / 100).toFixed(2));

      batch.push({ ts, severity, service, message });
    }

    // Batch insert
    const values = batch.map((_, idx) => `($${idx * 4 + 1}, $${idx * 4 + 2}, $${idx * 4 + 3}, $${idx * 4 + 4})`).join(',');
    const params = batch.flatMap(b => [b.ts, b.severity, b.service, b.message]);
    await db.query(`INSERT INTO logs (ts, severity, service, message) VALUES ${values}`, params);
    
    if ((i + BATCH_SIZE) % 10000 === 0) {
      console.log(`Seeded ${i + BATCH_SIZE} rows...`);
    }
  }

  await db.query('COMMIT');
  const duration = (Date.now() - startTime) / 1000;
  console.log(`Seeding completed in ${duration.toFixed(1)}s`);
}

async function initializeDatabase() {
  db = new PGlite('./pgdata');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);

  // Indexes for performance
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);`);
  // For message search, a simple index; substring will use sequential scan but with small data ok, or we can add trigram if supported
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_message ON logs (message);`);

  await seedDatabase();
}

function validateParams(req, res) {
  const { offset, limit, severity, q } = req.query;

  if (offset !== undefined) {
    const off = parseInt(offset);
    if (isNaN(off) || off < 0) {
      res.status(400).json({ error: 'Invalid offset: must be non-negative integer' });
      return false;
    }
  }

  if (limit !== undefined) {
    const lim = parseInt(limit);
    if (isNaN(lim) || lim < 1 || lim > 200) {
      res.status(400).json({ error: 'Invalid limit: must be between 1 and 200' });
      return false;
    }
  }

  if (severity !== undefined && severity !== '' && !['debug', 'info', 'warn', 'error'].includes(severity)) {
    res.status(400).json({ error: 'Invalid severity: must be debug, info, warn, or error' });
    return false;
  }

  return true;
}

app.get('/api/logs', async (req, res) => {
  if (!validateParams(req, res)) return;

  const offset = parseInt(req.query.offset) || 0;
  const limit = Math.min(parseInt(req.query.limit) || 100, 200);
  const severity = req.query.severity || '';
  const q = req.query.q || '';

  try {
    let whereClauses = [];
    let params = [];
    let paramIdx = 1;

    if (severity) {
      whereClauses.push(`severity = $${paramIdx++}`);
      params.push(severity);
    }

    if (q) {
      whereClauses.push(`LOWER(message) LIKE $${paramIdx++}`);
      params.push(`%${q.toLowerCase()}%`);
    }

    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Count total
    const countQuery = `SELECT COUNT(*) as total FROM logs ${where}`;
    const countResult = await db.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total);

    // Get rows
    const dataQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${where}
      ORDER BY ts DESC 
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    const dataParams = [...params, limit, offset];
    const dataResult = await db.query(dataQuery, dataParams);

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

    const sevResult = await db.query(`
      SELECT severity, COUNT(*) as count 
      FROM logs 
      GROUP BY severity
    `);

    const perSeverity = {};
    SEVERITIES.forEach(s => perSeverity[s] = 0);
    sevResult.rows.forEach(row => {
      perSeverity[row.severity] = parseInt(row.count);
    });

    res.json({ total, perSeverity });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function startServer() {
  await initializeDatabase();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);