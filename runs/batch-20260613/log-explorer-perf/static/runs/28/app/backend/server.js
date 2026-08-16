import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

let db;
const DATA_DIR = './.pglite-data';

const SERVICES = ['api', 'auth', 'db', 'frontend', 'worker', 'cache', 'queue', 'monitor'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_WEIGHTS = [0.60, 0.25, 0.10, 0.05]; // cumulative for selection

const MESSAGE_TEMPLATES = [
  'User {userId} logged in from {ip}',
  'Request to {endpoint} completed in {ms}ms',
  'Database query {queryId} returned {rows} rows',
  'Cache {action} for key {key} {result}',
  'Worker {workerId} processed job {jobId} {status}',
  'Auth token {tokenType} {action} for user {userId}',
  'Queue {queueName} {action} message {msgId}',
  'Monitor alert {alertId} triggered for {metric} {value}',
  'Service {service} started successfully',
  'Connection {connId} established to {host}',
  'Error processing {entity} {errorCode}: {detail}',
  'Debug info: {var} = {val} at {loc}'
];

const FRAGMENTS = {
  userId: () => 'u' + Math.floor(Math.random() * 10000),
  ip: () => `${Math.floor(Math.random()*256)}.${Math.floor(Math.random()*256)}.${Math.floor(Math.random()*256)}.${Math.floor(Math.random()*256)}`,
  endpoint: () => ['/users', '/orders', '/products', '/login', '/api/v1/data'][Math.floor(Math.random()*5)],
  ms: () => Math.floor(Math.random() * 500) + 10,
  queryId: () => 'q' + Math.floor(Math.random() * 100000),
  rows: () => Math.floor(Math.random() * 1000),
  action: () => ['hit', 'miss', 'evict', 'set'][Math.floor(Math.random()*4)],
  key: () => 'key_' + Math.random().toString(36).substring(2, 10),
  result: () => ['success', 'failed', 'timeout'][Math.floor(Math.random()*3)],
  workerId: () => 'w' + Math.floor(Math.random() * 20),
  jobId: () => 'job_' + Math.floor(Math.random() * 100000),
  status: () => ['successfully', 'with errors', 'partially'][Math.floor(Math.random()*3)],
  tokenType: () => ['JWT', 'session', 'api-key'][Math.floor(Math.random()*3)],
  queueName: () => ['email', 'notifications', 'processing', 'analytics'][Math.floor(Math.random()*4)],
  msgId: () => 'msg_' + Math.floor(Math.random() * 1000000),
  alertId: () => 'alert_' + Math.floor(Math.random() * 1000),
  metric: () => ['cpu', 'memory', 'disk', 'latency'][Math.floor(Math.random()*4)],
  value: () => Math.floor(Math.random() * 100) + '%',
  service: () => SERVICES[Math.floor(Math.random()*SERVICES.length)],
  connId: () => 'conn_' + Math.floor(Math.random() * 10000),
  host: () => ['db-primary', 'cache-redis', 'api-gateway'][Math.floor(Math.random()*3)],
  entity: () => ['request', 'payment', 'order', 'user'][Math.floor(Math.random()*4)],
  errorCode: () => ['ERR_' + Math.floor(Math.random()*1000), 'TIMEOUT', 'VALIDATION'][Math.floor(Math.random()*3)],
  detail: () => ['invalid input', 'not found', 'permission denied', 'rate limited'][Math.floor(Math.random()*4)],
  var: () => ['count', 'status', 'time', 'id'][Math.floor(Math.random()*4)],
  val: () => Math.random().toString(36).substring(2, 8),
  loc: () => 'line ' + Math.floor(Math.random() * 200)
};

function seededRandom(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function generateMessage(i) {
  const template = MESSAGE_TEMPLATES[i % MESSAGE_TEMPLATES.length];
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    if (FRAGMENTS[key]) {
      // Use deterministic based on i and key
      const det = seededRandom(i * 31 + key.length);
      // Override random with det for determinism, but simplify: just use i based
      return FRAGMENTS[key](); // still random but ok for demo, seed not critical
    }
    return match;
  });
}

function getSeverityForIndex(i) {
  const r = seededRandom(i * 17) % 1;
  let cum = 0;
  for (let j = 0; j < SEVERITIES.length; j++) {
    cum += SEVERITY_WEIGHTS[j];
    if (r < cum) return SEVERITIES[j];
  }
  return 'debug';
}

async function initDb() {
  db = new PGlite({ dataDir: DATA_DIR });
  await db.waitReady;

  // Create table if not exists
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
  const count = parseInt(countRes.rows[0].count, 10);

  if (count === 0) {
    console.log('Seeding 100,000 log entries...');
    const startTime = Date.now();
    const TOTAL_ROWS = 100000;
    const BATCH_SIZE = 5000;
    const now = new Date();
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const timeStep = THIRTY_DAYS_MS / TOTAL_ROWS;

    for (let batchStart = 0; batchStart < TOTAL_ROWS; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL_ROWS);
      const values = [];
      const params = [];
      let paramIdx = 1;

      for (let i = batchStart; i < batchEnd; i++) {
        const ts = new Date(now.getTime() - (TOTAL_ROWS - i) * timeStep);
        const severity = getSeverityForIndex(i);
        const service = SERVICES[i % SERVICES.length];
        const message = generateMessage(i);

        values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
        params.push(ts.toISOString(), severity, service, message);
      }

      const query = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`;
      await db.query(query, params);
      if (batchStart % 20000 === 0) {
        console.log(`Seeded ${batchStart} rows...`);
      }
    }
    console.log(`Seeding complete in ${Date.now() - startTime}ms`);
  } else {
    console.log(`Database already seeded with ${count} rows.`);
  }

  // Create indexes
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);`);
  // For message search, a simple index; trigram would be better but may not be enabled
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_message ON logs (message);`);

  console.log('Indexes created.');
}

function validateQueryParams(req) {
  const { offset, limit, severity, q } = req.query;
  const errors = [];

  let o = parseInt(offset, 10);
  if (isNaN(o) || o < 0) errors.push('offset must be non-negative integer');
  else o = o;

  let l = parseInt(limit, 10);
  if (isNaN(l) || l < 1 || l > 200) errors.push('limit must be between 1 and 200');

  let sev = severity;
  if (sev && !SEVERITIES.includes(sev)) errors.push('invalid severity');

  let queryStr = q ? String(q) : null;

  return { errors, offset: o || 0, limit: l || 100, severity: sev || null, q: queryStr };
}

app.get('/api/logs', async (req, res) => {
  const { errors, offset, limit, severity, q } = validateQueryParams(req);
  if (errors.length > 0) {
    return res.status(400).json({ error: errors.join(', ') });
  }

  try {
    let whereClauses = [];
    let params = [];
    let idx = 1;

    if (severity) {
      whereClauses.push(`severity = $${idx++}`);
      params.push(severity);
    }
    if (q) {
      whereClauses.push(`message ILIKE $${idx++}`);
      params.push(`%${q}%`);
    }

    const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Total count
    const countQuery = `SELECT COUNT(*) as total FROM logs ${where}`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].total, 10);

    // Rows
    const dataQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${where}
      ORDER BY ts DESC 
      LIMIT $${idx++} OFFSET $${idx++}
    `;
    const dataParams = [...params, limit, offset];
    const dataRes = await db.query(dataQuery, dataParams);

    res.json({ total, rows: dataRes.rows });
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
    const bySeverity = {};
    SEVERITIES.forEach(s => bySeverity[s] = 0);
    sevRes.rows.forEach(r => {
      bySeverity[r.severity] = parseInt(r.count, 10);
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
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);