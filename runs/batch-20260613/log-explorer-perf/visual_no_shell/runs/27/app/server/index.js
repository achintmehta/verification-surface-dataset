import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let db;

const SERVICES = ['api', 'auth', 'payment', 'user', 'order', 'inventory', 'notification', 'analytics'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_WEIGHTS = [0.60, 0.25, 0.10, 0.05]; // cumulative for selection
const MESSAGE_TEMPLATES = [
  'User {userId} logged in from {ip}',
  'Request to {endpoint} completed in {time}ms',
  'Payment of ${amount} processed for order {orderId}',
  'Failed to connect to service {service}',
  'Cache miss for key {key}',
  'Database query took {time}ms',
  'Notification sent to user {userId}',
  'Inventory updated for product {productId}: {delta}',
  'Auth token refreshed for user {userId}',
  'Error processing request: {errorMsg}'
];

function seededRandom(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function getSeverityForIndex(index) {
  const r = seededRandom(index * 1.1);
  let cum = 0;
  for (let i = 0; i < SEVERITIES.length; i++) {
    cum += SEVERITY_WEIGHTS[i];
    if (r < cum) return SEVERITIES[i];
  }
  return 'debug';
}

function generateMessage(index, service) {
  const template = MESSAGE_TEMPLATES[index % MESSAGE_TEMPLATES.length];
  const userId = 1000 + (index % 9000);
  const ip = `192.168.1.${(index % 200) + 1}`;
  const endpoint = ['/users', '/orders', '/payments', '/search'][index % 4];
  const time = 10 + (index % 500);
  const amount = (index % 1000) + 10;
  const orderId = 'ORD-' + (100000 + index % 900000);
  const key = 'cache:' + (index % 10000);
  const productId = 'PROD-' + (index % 5000);
  const delta = (index % 20) - 10;
  const errorMsg = ['timeout', 'invalid input', 'not found', 'permission denied'][index % 4];
  return template
    .replace('{userId}', userId)
    .replace('{ip}', ip)
    .replace('{endpoint}', endpoint)
    .replace('{time}', time)
    .replace('{amount}', amount)
    .replace('{orderId}', orderId)
    .replace('{key}', key)
    .replace('{service}', service)
    .replace('{productId}', productId)
    .replace('{delta}', delta)
    .replace('{errorMsg}', errorMsg);
}

async function seedDatabase() {
  console.log('Checking if database needs seeding...');
  const countRes = await db.query('SELECT COUNT(*) as count FROM logs');
  const count = parseInt(countRes.rows[0].count, 10);
  if (count >= 100000) {
    console.log(`Database already has ${count} rows, skipping seed.`);
    return;
  }

  console.log('Seeding 100,000 log entries...');
  const startTime = Date.now();
  const TOTAL_ROWS = 100000;
  const BATCH_SIZE = 5000;
  const now = new Date();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  await db.query('BEGIN');
  try {
    for (let batchStart = 0; batchStart < TOTAL_ROWS; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL_ROWS);
      const values = [];
      const params = [];
      let paramIndex = 1;

      for (let i = batchStart; i < batchEnd; i++) {
        const service = SERVICES[i % SERVICES.length];
        const severity = getSeverityForIndex(i);
        // Deterministic timestamp: spread over 30 days, newest first-ish but varied
        const offsetMs = Math.floor(seededRandom(i * 3.7) * thirtyDaysMs);
        const ts = new Date(now.getTime() - offsetMs).toISOString();
        const message = generateMessage(i, service);

        values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
        params.push(ts, severity, service, message);
      }

      const query = `INSERT INTO logs (ts, severity, service, message, id) VALUES ${values.join(', ')}`;
      await db.query(query, params);
      if (batchStart % 20000 === 0) {
        console.log(`Seeded ${batchStart} rows...`);
      }
    }
    await db.query('COMMIT');
    console.log(`Seeding complete in ${Date.now() - startTime}ms`);
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
}

async function initializeDatabase() {
  db = new PGlite('./.pglite');

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
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_service ON logs (service);`);

  // For message search, a simple index; PGLite supports btree on text
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_message ON logs (message);`);

  await seedDatabase();
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

    const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Count total
    const countQuery = `SELECT COUNT(*) as total FROM logs ${where}`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].total, 10);

    // Fetch rows - note: for deep offsets, still use OFFSET as 100k is manageable
    const dataQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${where}
      ORDER BY ts DESC, id DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
    const dataParams = [...params, limit, offset];
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