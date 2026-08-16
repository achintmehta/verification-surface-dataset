import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

let db;

const SERVICES = ['api', 'auth', 'db', 'frontend', 'worker', 'cache', 'queue', 'monitor'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_WEIGHTS = [0.60, 0.25, 0.10, 0.05]; // cumulative for distribution

// Deterministic PRNG
function mulberry32(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function getSeverity(rand) {
  let cum = 0;
  for (let i = 0; i < SEVERITIES.length; i++) {
    cum += SEVERITY_WEIGHTS[i];
    if (rand < cum) return SEVERITIES[i];
  }
  return SEVERITIES[SEVERITIES.length - 1];
}

const MESSAGE_TEMPLATES = [
  'User {id} logged in from {ip}',
  'Request to {endpoint} completed in {time}ms',
  'Database query {query} returned {rows} rows',
  'Cache {action} for key {key} {result}',
  'Worker processed job {jobId} with status {status}',
  'Auth token {action} for user {userId}',
  'Queue {queue} has {count} pending messages',
  'Monitor alert: {metric} {threshold} on {service}',
  'Error processing {entity}: {reason}',
  'Connection {action} to {host}:{port}'
];

const FRAGMENTS = {
  endpoint_choices: ['/users', '/orders', '/products', '/auth/login', '/api/v1/data'],
  query_choices: ['SELECT * FROM users', 'UPDATE orders SET status=1', 'INSERT INTO logs'],
  action_choices: ['hit', 'miss', 'evict', 'refresh', 'validate'],
  result_choices: ['succeeded', 'failed', 'timeout'],
  status_choices: ['completed', 'failed', 'retrying'],
  queue_choices: ['email', 'notifications', 'analytics', 'exports'],
  metric_choices: ['cpu', 'memory', 'disk', 'latency'],
  threshold_choices: ['exceeded', 'below', 'at limit'],
  service_choices: SERVICES,
  entity_choices: ['payment', 'order', 'user profile', 'inventory'],
  reason_choices: ['timeout', 'validation error', 'not found', 'permission denied'],
  host_choices: ['db.internal', 'cache.cluster', 'api.gateway'],
  port_choices: [5432, 6379, 8080]
};

function generateMessage(rand, index) {
  const template = MESSAGE_TEMPLATES[index % MESSAGE_TEMPLATES.length];
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    if (FRAGMENTS[key]) {
      // Deterministic based on index and rand state
      const r = rand();
      if (key === 'ip') {
        return `${Math.floor(r*256)}.${Math.floor((r*1000)%256)}.${Math.floor((r*10000)%256)}.${Math.floor((r*100000)%256)}`;
      }
      const choices = FRAGMENTS[key + '_choices'] || [];
      if (choices.length > 0) {
        return choices[Math.floor(r * choices.length)];
      }
      if (key === 'time') return Math.floor(r * 500) + 10;
      if (key === 'rows') return Math.floor(r * 1000);
      if (key === 'key') return 'key_' + Math.floor(r * 10000);
      if (key === 'jobId') return 'job_' + Math.floor(r * 100000);
      if (key === 'userId') return Math.floor(r * 100000);
      if (key === 'count') return Math.floor(r * 500);
      return 'val' + Math.floor(r * 100);
    }
    return match;
  });
}

async function initializeDatabase() {
  db = new PGlite('./pglite-data');
  await db.waitReady;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL,
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);

  // Create indexes
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_message ON logs (message);`);

  const countResult = await db.query('SELECT COUNT(*) as count FROM logs');
  const rowCount = parseInt(countResult.rows[0].count);

  if (rowCount === 0) {
    console.log('Seeding 100,000 log entries...');
    await seedLogs();
    console.log('Seeding complete.');
  } else {
    console.log(`Database already seeded with ${rowCount} rows.`);
  }
}

async function seedLogs() {
  const TOTAL_ROWS = 100000;
  const BATCH_SIZE = 1000;
  const START_DATE = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
  const END_DATE = new Date();

  const rand = mulberry32(42); // deterministic seed

  for (let batch = 0; batch < TOTAL_ROWS / BATCH_SIZE; batch++) {
    const values = [];
    const params = [];
    let paramIndex = 1;

    for (let i = 0; i < BATCH_SIZE; i++) {
      const globalIndex = batch * BATCH_SIZE + i;
      // Deterministic timestamp: evenly distributed over 30 days + some jitter
      const progress = globalIndex / TOTAL_ROWS;
      const baseTime = START_DATE.getTime() + progress * (END_DATE.getTime() - START_DATE.getTime());
      const jitter = (rand() - 0.5) * 1000 * 60 * 5; // +/- 5 min jitter
      const ts = new Date(baseTime + jitter).toISOString();

      const severityRand = rand();
      const severity = getSeverity(severityRand);
      const service = SERVICES[globalIndex % SERVICES.length];
      const message = generateMessage(rand, globalIndex);

      values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
      params.push(ts, severity, service, message);
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`;
    await db.query(sql, params);

    if (batch % 10 === 0) {
      console.log(`Seeded batch ${batch + 1}/${TOTAL_ROWS / BATCH_SIZE}`);
    }
  }
}

function validateParams(offset, limit, severity) {
  if (offset < 0) return 'Offset must be non-negative';
  if (limit < 1 || limit > 200) return 'Limit must be between 1 and 200';
  if (severity && !SEVERITIES.includes(severity)) return 'Invalid severity';
  return null;
}

app.get('/api/logs', async (req, res) => {
  try {
    const offset = parseInt(req.query.offset) || 0;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const severity = req.query.severity || null;
    const q = req.query.q || null;

    const validationError = validateParams(offset, limit, severity);
    if (validationError) {
      return res.status(400).json({ error: validationError });
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

    // Total count
    const countSql = `SELECT COUNT(*) as total FROM logs ${where}`;
    const countResult = await db.query(countSql, params);
    const total = parseInt(countResult.rows[0].total);

    // Rows
    const rowsSql = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${where} 
      ORDER BY ts DESC 
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
    const queryParams = [...params, limit, offset];
    const rowsResult = await db.query(rowsSql, queryParams);

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
    const totalResult = await db.query('SELECT COUNT(*) as total FROM logs');
    const total = parseInt(totalResult.rows[0].total);

    const severityResult = await db.query(`
      SELECT severity, COUNT(*) as count 
      FROM logs 
      GROUP BY severity
    `);

    const perSeverity = {};
    SEVERITIES.forEach(s => perSeverity[s] = 0);
    severityResult.rows.forEach(row => {
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
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);