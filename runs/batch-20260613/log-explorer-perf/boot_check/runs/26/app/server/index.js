import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

let db;

const SERVICES = [
  'auth-service', 'api-gateway', 'user-service', 'payment-service',
  'notification-service', 'analytics-service', 'search-service', 'cache-service'
];

const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_WEIGHTS = [0.60, 0.25, 0.10, 0.05]; // cumulative for selection

const MESSAGE_TEMPLATES = [
  'User {userId} logged in from {ip}',
  'Request to {endpoint} completed in {ms}ms',
  'Database query {queryType} took {ms}ms',
  'Cache {action} for key {key}',
  'Payment {status} for order {orderId}',
  'Notification sent to user {userId}',
  'Search query "{query}" returned {count} results',
  'Session {action} for user {userId}',
  'Error processing {resource}: {reason}',
  'Config {action} for service {service}'
];

const MESSAGE_FRAGMENTS = {
  userId: (rand) => 'u' + Math.floor(rand() * 100000),
  ip: (rand) => `${Math.floor(rand()*256)}.${Math.floor(rand()*256)}.${Math.floor(rand()*256)}.${Math.floor(rand()*256)}`,
  endpoint: (rand) => ['/api/users', '/api/orders', '/api/products', '/health', '/api/auth'][Math.floor(rand()*5)],
  ms: (rand) => Math.floor(rand() * 500) + 1,
  queryType: (rand) => ['SELECT', 'INSERT', 'UPDATE', 'DELETE'][Math.floor(rand()*4)],
  action: (rand) => ['hit', 'miss', 'evict', 'refresh', 'created', 'updated', 'deleted'][Math.floor(rand()*7)],
  key: (rand) => 'key-' + rand().toString(36).substring(2, 10),
  status: (rand) => ['succeeded', 'failed', 'pending'][Math.floor(rand()*3)],
  orderId: (rand) => 'ord-' + Math.floor(rand() * 1000000),
  count: (rand) => Math.floor(rand() * 1000),
  query: (rand) => ['laptop', 'shoes', 'user login', 'error rate', 'dashboard'][Math.floor(rand()*5)],
  resource: (rand) => ['file', 'image', 'report', 'job', 'task'][Math.floor(rand()*5)],
  reason: (rand) => ['timeout', 'not found', 'permission denied', 'invalid input', 'internal error'][Math.floor(rand()*5)],
  service: (rand) => SERVICES[Math.floor(rand()*SERVICES.length)]
};

function seededRandom(seed) {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return function() {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

function pickSeverity(rand) {
  const r = rand();
  let cum = 0;
  for (let i = 0; i < SEVERITIES.length; i++) {
    cum += SEVERITY_WEIGHTS[i];
    if (r <= cum) return SEVERITIES[i];
  }
  return 'debug';
}

function generateMessage(rand) {
  const template = MESSAGE_TEMPLATES[Math.floor(rand() * MESSAGE_TEMPLATES.length)];
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const fn = MESSAGE_FRAGMENTS[key];
    return fn ? fn(rand) : match;
  });
}

async function seedDatabase() {
  console.log('Seeding database with 100,000 log entries...');
  const startTime = Date.now();
  const TOTAL_ROWS = 100000;
  const BATCH_SIZE = 2000;
  const startTs = new Date('2024-01-01T00:00:00Z').getTime();
  const endTs = new Date('2024-01-31T00:00:00Z').getTime();
  const timeRange = endTs - startTs;

  const rand = seededRandom(42); // deterministic seed

  await db.exec('BEGIN');
  try {
    for (let i = 0; i < TOTAL_ROWS; i += BATCH_SIZE) {
      const batch = [];
      const values = [];
      let paramIdx = 1;
      for (let j = 0; j < BATCH_SIZE && (i + j) < TOTAL_ROWS; j++) {
        const idx = i + j;
        const ts = new Date(startTs + Math.floor(rand() * timeRange));
        const severity = pickSeverity(rand);
        const service = SERVICES[Math.floor(rand() * SERVICES.length)];
        const message = generateMessage(rand);
        batch.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
        values.push(idx, ts.toISOString(), severity, service, message);
      }
      if (batch.length > 0) {
        const sql = `INSERT INTO logs (id, ts, severity, service, message) VALUES ${batch.join(', ')}`;
        await db.query(sql, values);
      }
      if (i % 10000 === 0) {
        console.log(`Seeded ${i} rows...`);
      }
    }
    await db.exec('COMMIT');
    console.log(`Seeding complete in ${((Date.now() - startTime)/1000).toFixed(1)}s`);
  } catch (e) {
    await db.exec('ROLLBACK');
    throw e;
  }
}

async function initializeDatabase() {
  db = new PGlite({ dataDir: './.pglite' });
  await db.waitReady;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL,
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);

  // Create indexes
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);`);

  const countRes = await db.query('SELECT COUNT(*) as count FROM logs');
  const count = parseInt(countRes.rows[0].count);

  if (count === 0) {
    await seedDatabase();
  } else {
    console.log(`Database already seeded with ${count} rows. Skipping seed.`);
  }

  // Verify
  const finalCount = await db.query('SELECT COUNT(*) as count FROM logs');
  console.log(`Total logs in DB: ${finalCount.rows[0].count}`);
}

function validateParams(req, res) {
  const offset = parseInt(req.query.offset) || 0;
  const limit = parseInt(req.query.limit) || 100;
  const severity = req.query.severity;
  const q = req.query.q;

  if (offset < 0) {
    res.status(400).json({ error: 'offset must be >= 0' });
    return null;
  }
  if (limit < 1 || limit > 200) {
    res.status(400).json({ error: 'limit must be between 1 and 200' });
    return null;
  }
  if (severity && !['debug', 'info', 'warn', 'error'].includes(severity)) {
    res.status(400).json({ error: 'invalid severity' });
    return null;
  }
  return { offset, limit, severity, q: q || null };
}

app.get('/api/logs', async (req, res) => {
  const params = validateParams(req, res);
  if (!params) return;

  const { offset, limit, severity, q } = params;

  try {
    let whereClauses = [];
    let queryParams = [];
    let paramIdx = 1;

    if (severity) {
      whereClauses.push(`severity = $${paramIdx++}`);
      queryParams.push(severity);
    }
    if (q) {
      whereClauses.push(`message ILIKE $${paramIdx++}`);
      queryParams.push(`%${q}%`);
    }

    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Total count
    const countSql = `SELECT COUNT(*) as total FROM logs ${where}`;
    const countRes = await db.query(countSql, queryParams);
    const total = parseInt(countRes.rows[0].total);

    // Rows
    const rowsSql = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${where}
      ORDER BY ts DESC 
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    const rowsParams = [...queryParams, limit, offset];
    const rowsRes = await db.query(rowsSql, rowsParams);

    res.json({
      total,
      rows: rowsRes.rows
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
    sevRes.rows.forEach(row => {
      bySeverity[row.severity] = parseInt(row.count);
    });

    res.json({ total, bySeverity });
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