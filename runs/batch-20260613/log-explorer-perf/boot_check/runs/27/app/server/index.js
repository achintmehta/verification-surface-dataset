const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

let db;
let isSeeded = false;

const SERVICES = ['auth', 'api', 'db', 'frontend', 'worker', 'cache', 'queue', 'monitor'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_WEIGHTS = [0.60, 0.25, 0.10, 0.05];
const MESSAGE_TEMPLATES = [
  'User {id} logged in from {ip}',
  'Request to {endpoint} completed in {time}ms',
  'Database query {query} returned {rows} rows',
  'Cache {action} for key {key}',
  'Worker processed job {jobId} with status {status}',
  'Queue {queue} has {count} pending messages',
  'Monitor alert: {metric} is {value}',
  'Auth token {action} for user {userId}'
];

function seededRandom(seed) {
  let x = Math.sin(seed++) * 10000;
  return x - Math.floor(x);
}

function generateLogEntry(index, total) {
  const seed = index;
  const rand = (s) => seededRandom(seed + s);
  
  // Timestamp: spread over 30 days, deterministic
  const now = new Date('2024-01-01T00:00:00Z').getTime();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  const ts = new Date(now - (total - index) * (thirtyDays / total) + (rand(1) - 0.5) * 1000 * 60);
  
  // Severity based on weights
  let sevRand = rand(2);
  let severity;
  let cum = 0;
  for (let i = 0; i < SEVERITIES.length; i++) {
    cum += SEVERITY_WEIGHTS[i];
    if (sevRand <= cum) {
      severity = SEVERITIES[i];
      break;
    }
  }
  
  const service = SERVICES[Math.floor(rand(3) * SERVICES.length)];
  
  // Message
  let template = MESSAGE_TEMPLATES[Math.floor(rand(4) * MESSAGE_TEMPLATES.length)];
  const id = Math.floor(rand(5) * 10000);
  const ip = `192.168.${Math.floor(rand(6)*255)}.${Math.floor(rand(7)*255)}`;
  const endpoint = ['/users', '/orders', '/products', '/login'][Math.floor(rand(8)*4)];
  const time = Math.floor(rand(9) * 500) + 10;
  const query = ['SELECT *', 'INSERT', 'UPDATE', 'DELETE'][Math.floor(rand(10)*4)];
  const rows = Math.floor(rand(11) * 1000);
  const action = ['hit', 'miss', 'evict'][Math.floor(rand(12)*3)];
  const key = `key_${Math.floor(rand(13)*1000)}`;
  const jobId = `job_${Math.floor(rand(14)*10000)}`;
  const status = ['success', 'failed', 'retry'][Math.floor(rand(15)*3)];
  const queue = ['high', 'normal', 'low'][Math.floor(rand(16)*3)];
  const count = Math.floor(rand(17) * 100);
  const metric = ['cpu', 'memory', 'disk'][Math.floor(rand(18)*3)];
  const value = Math.floor(rand(19) * 100);
  const userId = Math.floor(rand(20) * 10000);
  const tokenAction = ['issued', 'revoked', 'refreshed'][Math.floor(rand(21)*3)];
  
  let message = template
    .replace('{id}', id)
    .replace('{ip}', ip)
    .replace('{endpoint}', endpoint)
    .replace('{time}', time)
    .replace('{query}', query)
    .replace('{rows}', rows)
    .replace('{action}', action)
    .replace('{key}', key)
    .replace('{jobId}', jobId)
    .replace('{status}', status)
    .replace('{queue}', queue)
    .replace('{count}', count)
    .replace('{metric}', metric)
    .replace('{value}', value)
    .replace('{userId}', userId)
    .replace('{action}', tokenAction);
  
  return { ts: ts.toISOString(), severity, service, message };
}

async function initDb() {
  db = new PGlite('./pgdata');
  await db.waitReady;
  
  // Create table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL,
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);
  
  // Check if seeded
  const countRes = await db.query('SELECT COUNT(*) as count FROM logs');
  const count = parseInt(countRes.rows[0].count);
  
  if (count === 0) {
    console.log('Seeding 100,000 log entries...');
    const start = Date.now();
    const TOTAL = 100000;
    const BATCH_SIZE = 1000;
    
    for (let batch = 0; batch < TOTAL / BATCH_SIZE; batch++) {
      const values = [];
      const params = [];
      let paramIdx = 1;
      
      for (let i = 0; i < BATCH_SIZE; i++) {
        const idx = batch * BATCH_SIZE + i;
        const entry = generateLogEntry(idx, TOTAL);
        values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
        params.push(entry.ts, entry.severity, entry.service, entry.message);
      }
      
      await db.query(
        `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`,
        params
      );
      
      if (batch % 20 === 0) {
        console.log(`Seeded ${batch * BATCH_SIZE} rows...`);
      }
    }
    
    console.log(`Seeding completed in ${Date.now() - start}ms`);
    
    // Create indexes
    console.log('Creating indexes...');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_message ON logs USING gin (to_tsvector(\'simple\', message));'); // for search, fallback to like if not
    // Actually for ILIKE, may not help much, but ok. PGLite may support.
  } else {
    console.log(`Database already seeded with ${count} rows.`);
  }
  
  isSeeded = true;
}

function validateParams(req, res) {
  const { offset, limit, severity } = req.query;
  
  if (offset !== undefined) {
    const o = parseInt(offset);
    if (isNaN(o) || o < 0) {
      res.status(400).json({ error: 'Invalid offset' });
      return false;
    }
  }
  
  if (limit !== undefined) {
    const l = parseInt(limit);
    if (isNaN(l) || l < 1 || l > 200) {
      res.status(400).json({ error: 'Invalid limit (1-200)' });
      return false;
    }
  }
  
  if (severity !== undefined && severity !== '') {
    if (!SEVERITIES.includes(severity)) {
      res.status(400).json({ error: 'Invalid severity' });
      return false;
    }
  }
  
  return true;
}

app.get('/api/logs', async (req, res) => {
  if (!validateParams(req, res)) return;
  
  const offset = parseInt(req.query.offset) || 0;
  const limit = Math.min(parseInt(req.query.limit) || 100, 200);
  const severity = req.query.severity || '';
  const q = (req.query.q || '').toLowerCase().trim();
  
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
      params.push(`%${q}%`);
    }
    
    const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    
    // Total count
    const countQuery = `SELECT COUNT(*) as total FROM logs ${where}`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].total);
    
    // Rows
    const dataQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${where}
      ORDER BY ts DESC 
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    params.push(limit, offset);
    
    const dataRes = await db.query(dataQuery, params);
    
    res.json({ total, rows: dataRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Query failed' });
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
    
    const perSeverity = {};
    SEVERITIES.forEach(s => perSeverity[s] = 0);
    sevRes.rows.forEach(r => {
      perSeverity[r.severity] = parseInt(r.count);
    });
    
    res.json({ total, perSeverity });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Stats failed' });
  }
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

start().catch(console.error);