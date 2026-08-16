import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

const DATA_DIR = './.pglite-data';
const db = new PGlite(DATA_DIR);

const SERVICES = ['api', 'auth', 'database', 'cache', 'queue', 'worker', 'ui', 'billing'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const MSG_TEMPLATES = [
  'User {id} performed action {action} from IP {ip}',
  'Request to {endpoint} completed in {time}ms with status {status}',
  'Cache {op} for key {key} took {time}ms',
  'Database query {query} returned {rows} rows',
  'Queue job {job} processed for service {service}',
  'Authentication {result} for user {user}',
  'Worker task {task} finished with result {result}',
  'Billing invoice {invoice} generated for amount ${amount}',
  'Connection {state} to {host}',
  'Error processing request: {error} at {location}'
];

function seededRandom(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function getDeterministicValue(index, max, seedOffset = 0) {
  return Math.floor(seededRandom(index + seedOffset) * max);
}

async function seedLogs() {
  console.log('Seeding 100,000 log entries...');
  const startTime = Date.now();
  const now = new Date();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const batchSize = 1000;
  const totalRows = 100000;

  for (let batch = 0; batch < totalRows / batchSize; batch++) {
    const values = [];
    const placeholders = [];
    let paramIndex = 1;

    for (let i = 0; i < batchSize; i++) {
      const globalIndex = batch * batchSize + i;
      // Deterministic timestamp: spread over 30 days, newest first-ish
      const timeOffset = getDeterministicValue(globalIndex, thirtyDaysMs, 1);
      const ts = new Date(now.getTime() - timeOffset);
      const tsStr = ts.toISOString();

      // Severity distribution ~60/25/10/5
      const sevRand = seededRandom(globalIndex + 2);
      let severity;
      if (sevRand < 0.60) severity = 'debug';
      else if (sevRand < 0.85) severity = 'info';
      else if (sevRand < 0.95) severity = 'warn';
      else severity = 'error';

      const service = SERVICES[getDeterministicValue(globalIndex, SERVICES.length, 3)];

      // Message
      const template = MSG_TEMPLATES[getDeterministicValue(globalIndex, MSG_TEMPLATES.length, 4)];
      const message = template
        .replace('{id}', getDeterministicValue(globalIndex, 10000, 5))
        .replace('{action}', ['login', 'logout', 'update', 'delete', 'create'][getDeterministicValue(globalIndex, 5, 6)])
        .replace('{ip}', `192.168.1.${getDeterministicValue(globalIndex, 255, 7)}`)
        .replace('{endpoint}', ['/users', '/orders', '/products', '/auth'][getDeterministicValue(globalIndex, 4, 8)])
        .replace('{time}', getDeterministicValue(globalIndex, 500, 9) + 10)
        .replace('{status}', [200, 201, 400, 404, 500][getDeterministicValue(globalIndex, 5, 10)])
        .replace('{op}', ['hit', 'miss', 'evict'][getDeterministicValue(globalIndex, 3, 11)])
        .replace('{key}', 'key_' + getDeterministicValue(globalIndex, 100000, 12))
        .replace('{query}', ['SELECT *', 'INSERT', 'UPDATE'][getDeterministicValue(globalIndex, 3, 13)])
        .replace('{rows}', getDeterministicValue(globalIndex, 1000, 14))
        .replace('{job}', 'job_' + getDeterministicValue(globalIndex, 1000, 15))
        .replace('{service}', service)
        .replace('{result}', ['success', 'failure', 'pending'][getDeterministicValue(globalIndex, 3, 16)])
        .replace('{user}', 'user_' + getDeterministicValue(globalIndex, 5000, 17))
        .replace('{task}', 'task_' + getDeterministicValue(globalIndex, 500, 18))
        .replace('{invoice}', 'INV-' + getDeterministicValue(globalIndex, 100000, 19))
        .replace('{amount}', (getDeterministicValue(globalIndex, 10000, 20) / 100).toFixed(2))
        .replace('{state}', ['opened', 'closed', 'timeout'][getDeterministicValue(globalIndex, 3, 21)])
        .replace('{host}', ['db-primary', 'cache-redis', 'api-gateway'][getDeterministicValue(globalIndex, 3, 22)])
        .replace('{error}', ['timeout', 'validation', 'not_found', 'permission'][getDeterministicValue(globalIndex, 4, 23)])
        .replace('{location}', ['handler', 'middleware', 'db-layer'][getDeterministicValue(globalIndex, 3, 24)]);

      values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
      placeholders.push(tsStr, severity, service, message);
    }

    const query = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`;
    await db.query(query, placeholders);
    if (batch % 10 === 0) {
      console.log(`Seeded batch ${batch + 1}/${totalRows / batchSize}`);
    }
  }
  console.log(`Seeding completed in ${Date.now() - startTime}ms`);
}

async function initializeDatabase() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);

  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);`);

  const countRes = await db.query('SELECT COUNT(*)::int as count FROM logs');
  const count = countRes.rows[0].count;

  if (count === 0) {
    await seedLogs();
  } else {
    console.log(`Database already seeded with ${count} rows. Skipping seed.`);
  }
}

app.get('/api/logs', async (req, res) => {
  try {
    let offset = parseInt(req.query.offset, 10) || 0;
    let limit = parseInt(req.query.limit, 10) || 50;
    const severity = req.query.severity;
    const q = req.query.q;

    if (offset < 0) {
      return res.status(400).json({ error: 'offset must be non-negative' });
    }
    if (limit < 1 || limit > 200) {
      return res.status(400).json({ error: 'limit must be between 1 and 200' });
    }
    if (severity && !SEVERITIES.includes(severity)) {
      return res.status(400).json({ error: 'invalid severity' });
    }

    let whereClauses = [];
    let params = [];
    let paramIdx = 1;

    if (severity) {
      whereClauses.push(`severity = $${paramIdx++}`);
      params.push(severity);
    }
    if (q && q.trim()) {
      whereClauses.push(`message ILIKE $${paramIdx++}`);
      params.push(`%${q.trim()}%`);
    }

    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Total count
    const totalQuery = `SELECT COUNT(*)::int as total FROM logs ${where}`;
    const totalResult = await db.query(totalQuery, params);
    const total = totalResult.rows[0].total;

    // Rows
    params.push(limit, offset);
    const rowsQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${where} 
      ORDER BY ts DESC, id DESC 
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    const rowsResult = await db.query(rowsQuery, params);

    res.json({
      total,
      rows: rowsResult.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const totalRes = await db.query('SELECT COUNT(*)::int as total FROM logs');
    const severityRes = await db.query(`
      SELECT severity, COUNT(*)::int as count 
      FROM logs 
      GROUP BY severity
    `);

    const bySeverity = {};
    SEVERITIES.forEach(s => bySeverity[s] = 0);
    severityRes.rows.forEach(row => {
      bySeverity[row.severity] = row.count;
    });

    res.json({
      total: totalRes.rows[0].total,
      bySeverity
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function start() {
  try {
    await initializeDatabase();
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();