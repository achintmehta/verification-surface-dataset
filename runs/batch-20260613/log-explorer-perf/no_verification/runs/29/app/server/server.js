const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

let db;

const SERVICES = ['api', 'auth', 'db', 'frontend', 'worker', 'cache', 'queue', 'monitor'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_WEIGHTS = [0.60, 0.25, 0.10, 0.05]; // cumulative for deterministic choice

const MESSAGE_TEMPLATES = [
  'User ${userId} performed action ${action} from IP ${ip}',
  'Request to ${endpoint} completed in ${duration}ms with status ${status}',
  'Cache ${operation} for key ${key} ${result}',
  'Database query ${queryType} on table ${table} affected ${rows} rows',
  'Service ${service} ${event} ${details}',
  'Authentication ${result} for user ${userId} using ${method}',
  'Background job ${jobId} ${status} after ${duration}ms',
  'Metric ${metric} reported value ${value} for ${entity}'
];

const ACTIONS = ['login', 'logout', 'update', 'delete', 'create', 'view'];
const ENDPOINTS = ['/users', '/orders', '/products', '/reports', '/settings'];
const DURATIONS = ['12', '45', '78', '123', '256', '512'];
const STATUSES = ['200', '201', '400', '404', '500'];
const OPERATIONS = ['hit', 'miss', 'evict', 'set'];
const RESULTS = ['succeeded', 'failed', 'timed out'];
const QUERY_TYPES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const TABLES = ['users', 'logs', 'sessions', 'orders'];
const EVENTS = ['started', 'stopped', 'restarted', 'scaled'];
const METHODS = ['password', 'oauth', 'token', 'sso'];
const JOB_IDS = ['job-1001', 'job-1002', 'job-1003', 'job-1004'];
const METRICS = ['cpu', 'memory', 'latency', 'throughput'];

function seededRandom(seed) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

function chooseSeverity(rand) {
  const r = rand();
  let cum = 0;
  for (let i = 0; i < SEVERITIES.length; i++) {
    cum += SEVERITY_WEIGHTS[i];
    if (r < cum) return SEVERITIES[i];
  }
  return SEVERITIES[SEVERITIES.length - 1];
}

function generateMessage(rand, index) {
  const template = MESSAGE_TEMPLATES[index % MESSAGE_TEMPLATES.length];
  return template
    .replace('${userId}', 'u' + (1000 + (index % 9000)))
    .replace('${action}', ACTIONS[index % ACTIONS.length])
    .replace('${ip}', `192.168.1.${(index % 200) + 1}`)
    .replace('${endpoint}', ENDPOINTS[index % ENDPOINTS.length])
    .replace('${duration}', DURATIONS[index % DURATIONS.length])
    .replace('${status}', STATUSES[index % STATUSES.length])
    .replace('${operation}', OPERATIONS[index % OPERATIONS.length])
    .replace('${key}', 'key-' + (index % 10000))
    .replace('${result}', RESULTS[index % RESULTS.length])
    .replace('${queryType}', QUERY_TYPES[index % QUERY_TYPES.length])
    .replace('${table}', TABLES[index % TABLES.length])
    .replace('${rows}', String(1 + (index % 500)))
    .replace('${service}', SERVICES[index % SERVICES.length])
    .replace('${event}', EVENTS[index % EVENTS.length])
    .replace('${details}', 'detail-' + (index % 100))
    .replace('${method}', METHODS[index % METHODS.length])
    .replace('${jobId}', JOB_IDS[index % JOB_IDS.length])
    .replace('${status}', RESULTS[index % RESULTS.length])
    .replace('${metric}', METRICS[index % METRICS.length])
    .replace('${value}', String(10 + (index % 90)))
    .replace('${entity}', 'entity-' + (index % 50));
}

async function initDb() {
  db = new PGlite('./.pglite');
  await db.waitReady;

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
  const rowCount = parseInt(countRes.rows[0].count, 10);

  if (rowCount === 0) {
    console.log('Seeding 100,000 log entries...');
    const startTime = Date.now();
    const totalRows = 100000;
    const batchSize = 1000;
    const startDate = new Date('2024-01-01T00:00:00Z').getTime();
    const endDate = new Date('2024-01-31T00:00:00Z').getTime();
    const timeSpan = endDate - startDate;

    const rand = seededRandom(42);

    for (let batchStart = 0; batchStart < totalRows; batchStart += batchSize) {
      const batchEnd = Math.min(batchStart + batchSize, totalRows);
      const values = [];
      const params = [];
      let paramIndex = 1;

      for (let i = batchStart; i < batchEnd; i++) {
        const progress = i / totalRows;
        const ts = new Date(startDate + Math.floor(progress * timeSpan) + (rand() * 1000));
        const severity = chooseSeverity(rand);
        const service = SERVICES[i % SERVICES.length];
        const message = generateMessage(rand, i);

        values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
        params.push(ts.toISOString(), severity, service, message);
      }

      const query = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`;
      await db.query(query, params);
      if ((batchStart / batchSize) % 10 === 0) {
        console.log(`Seeded ${batchEnd} rows...`);
      }
    }
    console.log(`Seeding completed in ${Date.now() - startTime}ms`);
  } else {
    console.log(`Database already seeded with ${rowCount} rows. Skipping seed.`);
  }

  // Create indexes
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_message ON logs (message);'); // for LIKE, though not perfect

  console.log('Indexes created.');
}

function validateParams(req, res) {
  const { offset, limit, severity, q } = req.query;

  if (offset !== undefined) {
    const o = parseInt(offset, 10);
    if (isNaN(o) || o < 0) {
      res.status(400).json({ error: 'Invalid offset: must be non-negative integer' });
      return false;
    }
  }

  if (limit !== undefined) {
    const l = parseInt(limit, 10);
    if (isNaN(l) || l < 1 || l > 200) {
      res.status(400).json({ error: 'Invalid limit: must be between 1 and 200' });
      return false;
    }
  }

  if (severity !== undefined && severity !== '') {
    if (!SEVERITIES.includes(severity)) {
      res.status(400).json({ error: 'Invalid severity: must be one of debug, info, warn, error' });
      return false;
    }
  }

  return true;
}

app.get('/api/logs', async (req, res) => {
  if (!validateParams(req, res)) return;

  const offset = parseInt(req.query.offset || '0', 10);
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 200);
  const severity = req.query.severity || '';
  const q = req.query.q || '';

  try {
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

    // Count total
    const countQuery = `SELECT COUNT(*) as total FROM logs ${where}`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].total, 10);

    // Fetch rows
    const dataParams = [...params];
    dataParams.push(limit, offset);
    const dataQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${where}
      ORDER BY ts DESC 
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
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

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);