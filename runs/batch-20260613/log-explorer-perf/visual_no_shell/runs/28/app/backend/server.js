import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

let db;

const SERVICES = ['api', 'auth', 'db', 'cache', 'worker', 'frontend', 'billing', 'notif'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_WEIGHTS = [0.60, 0.25, 0.10, 0.05];

const MESSAGE_TEMPLATES = [
  'User {userId} logged in from {ip}',
  'Request {reqId} processed in {time}ms',
  'Error in {service}: {errorCode} - {detail}',
  'Cache {action} for key {key} {result}',
  'Database query {queryType} on {table} returned {rows} rows',
  'Worker job {jobId} {status} after {duration}s',
  'Payment {paymentId} {action} for amount ${amount}',
  'Notification sent to {userId} via {channel}'
];

function seededRandom(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function getDeterministicValue(index, max, seedOffset = 0) {
  return Math.floor(seededRandom(index + seedOffset) * max);
}

function generateLogEntry(index) {
  const now = new Date('2024-01-01T00:00:00Z').getTime();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const ts = new Date(now - getDeterministicValue(index, thirtyDaysMs, 1));
  
  // Severity based on weights
  let rand = seededRandom(index + 2);
  let cum = 0;
  let severity = SEVERITIES[0];
  for (let i = 0; i < SEVERITIES.length; i++) {
    cum += SEVERITY_WEIGHTS[i];
    if (rand <= cum) {
      severity = SEVERITIES[i];
      break;
    }
  }
  
  const service = SERVICES[getDeterministicValue(index, SERVICES.length, 3)];
  
  // Message
  const template = MESSAGE_TEMPLATES[getDeterministicValue(index, MESSAGE_TEMPLATES.length, 4)];
  const message = template
    .replace('{userId}', 'u' + (1000 + getDeterministicValue(index, 9000, 5)))
    .replace('{ip}', `192.168.${getDeterministicValue(index, 255, 6)}.${getDeterministicValue(index, 255, 7)}`)
    .replace('{reqId}', 'req-' + (10000 + getDeterministicValue(index, 90000, 8)))
    .replace('{time}', String(5 + getDeterministicValue(index, 500, 9)))
    .replace('{service}', service)
    .replace('{errorCode}', 'E' + (100 + getDeterministicValue(index, 900, 10)))
    .replace('{detail}', ['timeout', 'invalid', 'notfound', 'denied', 'unknown'][getDeterministicValue(index, 5, 11)])
    .replace('{action}', ['hit', 'miss', 'evict', 'set'][getDeterministicValue(index, 4, 12)])
    .replace('{key}', 'key-' + getDeterministicValue(index, 100000, 13))
    .replace('{result}', ['success', 'failed'][getDeterministicValue(index, 2, 14)])
    .replace('{queryType}', ['SELECT', 'INSERT', 'UPDATE', 'DELETE'][getDeterministicValue(index, 4, 15)])
    .replace('{table}', ['users', 'orders', 'logs', 'sessions'][getDeterministicValue(index, 4, 16)])
    .replace('{rows}', String(getDeterministicValue(index, 1000, 17)))
    .replace('{jobId}', 'job-' + (1000 + getDeterministicValue(index, 50000, 18)))
    .replace('{status}', ['completed', 'failed', 'retrying'][getDeterministicValue(index, 3, 19)])
    .replace('{duration}', String(1 + getDeterministicValue(index, 300, 20)))
    .replace('{paymentId}', 'pay-' + (5000 + getDeterministicValue(index, 50000, 21)))
    .replace('{amount}', String(10 + getDeterministicValue(index, 10000, 22)))
    .replace('{channel}', ['email', 'sms', 'push'][getDeterministicValue(index, 3, 23)]);
  
  return {
    ts: ts.toISOString(),
    severity,
    service,
    message
  };
}

async function initDb() {
  db = new PGlite('./.pglite-data');
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
  
  // Check if already seeded
  const countRes = await db.query('SELECT COUNT(*) as count FROM logs');
  const count = parseInt(countRes.rows[0].count);
  
  if (count === 0) {
    console.log('Seeding 100,000 log entries...');
    const BATCH_SIZE = 1000;
    const TOTAL = 100000;
    
    for (let batch = 0; batch < TOTAL / BATCH_SIZE; batch++) {
      const values = [];
      const params = [];
      let paramIndex = 1;
      
      for (let i = 0; i < BATCH_SIZE; i++) {
        const entry = generateLogEntry(batch * BATCH_SIZE + i);
        values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
        params.push(entry.ts, entry.severity, entry.service, entry.message);
      }
      
      const query = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`;
      await db.query(query, params);
      
      if (batch % 10 === 0) {
        console.log(`Seeded ${(batch + 1) * BATCH_SIZE} rows...`);
      }
    }
    console.log('Seeding complete.');
  } else {
    console.log(`Database already seeded with ${count} rows.`);
  }
  
  // Create indexes
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_message ON logs USING gin (to_tsvector(\'simple\', message));'); // for better search, fallback to like if not
  
  console.log('Indexes created.');
}

function validateParams(req, res) {
  const { offset = '0', limit = '100', severity, q } = req.query;
  
  const off = parseInt(offset, 10);
  const lim = parseInt(limit, 10);
  
  if (isNaN(off) || off < 0) {
    res.status(400).json({ error: 'Invalid offset: must be non-negative integer' });
    return null;
  }
  
  if (isNaN(lim) || lim < 1 || lim > 200) {
    res.status(400).json({ error: 'Invalid limit: must be between 1 and 200' });
    return null;
  }
  
  if (severity && !['debug', 'info', 'warn', 'error'].includes(severity)) {
    res.status(400).json({ error: 'Invalid severity' });
    return null;
  }
  
  return { offset: off, limit: lim, severity, q };
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
      whereClauses.push(`LOWER(message) LIKE $${paramIdx++}`);
      queryParams.push(`%${q.toLowerCase()}%`);
    }
    
    const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    
    // Total count
    const countQuery = `SELECT COUNT(*) as total FROM logs ${where}`;
    const countRes = await db.query(countQuery, queryParams);
    const total = parseInt(countRes.rows[0].total);
    
    // Rows with window
    const dataQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${where}
      ORDER BY ts DESC 
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    const dataParams = [...queryParams, limit, offset];
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
    const total = parseInt(totalRes.rows[0].total);
    
    const sevRes = await db.query(`
      SELECT severity, COUNT(*) as count 
      FROM logs 
      GROUP BY severity
    `);
    
    const bySeverity = { debug: 0, info: 0, warn: 0, error: 0 };
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
  await initDb();
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);