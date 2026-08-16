const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

let db;

const SERVICES = ['api', 'auth', 'db', 'worker', 'frontend', 'cache', 'queue', 'notif'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_WEIGHTS = [0.6, 0.25, 0.1, 0.05]; // cumulative for distribution

const MESSAGE_TEMPLATES = [
  'User {id} logged in from {ip}',
  'Request to {endpoint} completed in {ms}ms',
  'Database query {query} took {ms}ms',
  'Cache miss for key {key}',
  'Processing job {jobId} for user {userId}',
  'Connection established to {service}',
  'Error processing request: {error}',
  'Warning: high memory usage {usage}%',
  'Debug: variable {var} = {value}',
  'Notification sent to {recipient}'
];

function seededRandom(seed) {
  let x = Math.sin(seed++) * 10000;
  return x - Math.floor(x);
}

function generateDeterministicLogs(count) {
  const logs = [];
  const startTime = new Date('2024-01-01T00:00:00Z').getTime();
  const endTime = new Date('2024-01-31T00:00:00Z').getTime();
  const timeRange = endTime - startTime;

  for (let i = 0; i < count; i++) {
    const seed = i * 12345;
    const ts = new Date(startTime + Math.floor(seededRandom(seed) * timeRange));
    
    // Severity distribution
    const r = seededRandom(seed + 1);
    let severity;
    if (r < 0.6) severity = 'debug';
    else if (r < 0.85) severity = 'info';
    else if (r < 0.95) severity = 'warn';
    else severity = 'error';
    
    const service = SERVICES[Math.floor(seededRandom(seed + 2) * SERVICES.length)];
    
    const template = MESSAGE_TEMPLATES[Math.floor(seededRandom(seed + 3) * MESSAGE_TEMPLATES.length)];
    const message = template
      .replace('{id}', Math.floor(seededRandom(seed + 4) * 10000))
      .replace('{ip}', `${Math.floor(seededRandom(seed + 5)*255)}.${Math.floor(seededRandom(seed + 6)*255)}.${Math.floor(seededRandom(seed + 7)*255)}.${Math.floor(seededRandom(seed + 8)*255)}`)
      .replace('{endpoint}', ['/users', '/orders', '/products', '/login'][Math.floor(seededRandom(seed + 9) * 4)])
      .replace('{ms}', Math.floor(seededRandom(seed + 10) * 500) + 10)
      .replace('{query}', ['SELECT *', 'UPDATE', 'INSERT', 'DELETE'][Math.floor(seededRandom(seed + 11) * 4)])
      .replace('{key}', `cache_${Math.floor(seededRandom(seed + 12) * 1000)}`)
      .replace('{jobId}', `job_${Math.floor(seededRandom(seed + 13) * 10000)}`)
      .replace('{userId}', Math.floor(seededRandom(seed + 14) * 100000))
      .replace('{service}', SERVICES[Math.floor(seededRandom(seed + 15) * SERVICES.length)])
      .replace('{error}', ['timeout', 'not found', 'invalid input', 'permission denied'][Math.floor(seededRandom(seed + 16) * 4)])
      .replace('{usage}', Math.floor(seededRandom(seed + 17) * 100))
      .replace('{var}', ['count', 'status', 'level', 'size'][Math.floor(seededRandom(seed + 18) * 4)])
      .replace('{value}', Math.floor(seededRandom(seed + 19) * 1000))
      .replace('{recipient}', `user${Math.floor(seededRandom(seed + 20) * 1000)}@example.com`);
    
    logs.push({ ts, severity, service, message });
  }
  
  // Sort by ts descending for insertion? No, we'll order in query
  logs.sort((a, b) => b.ts - a.ts);
  return logs;
}

async function initDb() {
  console.log('Initializing PGlite...');
  db = new PGlite({
    dataDir: './.pglite-data'
  });
  
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
    const startSeed = Date.now();
    const logs = generateDeterministicLogs(100000);
    
    // Batch insert
    const batchSize = 1000;
    for (let i = 0; i < logs.length; i += batchSize) {
      const batch = logs.slice(i, i + batchSize);
      const values = batch.map((log, idx) => {
        const globalIdx = i + idx;
        return `('${log.ts.toISOString()}', '${log.severity}', '${log.service}', '${log.message.replace(/'/g, "''")}')`;
      }).join(',');
      
      await db.exec(`
        INSERT INTO logs (ts, severity, service, message) 
        VALUES ${values}
      `);
      
      if (i % 10000 === 0) {
        console.log(`Seeded ${i} rows...`);
      }
    }
    
    console.log(`Seeding completed in ${Date.now() - startSeed}ms`);
  } else {
    console.log(`Database already has ${count} rows, skipping seed.`);
  }
  
  // Create indexes
  console.log('Creating indexes...');
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_message ON logs USING gin (to_tsvector('simple', message));
  `);
  
  console.log('Database ready.');
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
  
  if (severity !== undefined && severity !== '') {
    if (!['debug', 'info', 'warn', 'error'].includes(severity)) {
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
      whereClauses.push(`message ILIKE $${paramIdx++}`);
      params.push(`%${q}%`);
    }
    
    const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    
    // Get total
    const totalQuery = `SELECT COUNT(*) as total FROM logs ${where}`;
    const totalRes = await db.query(totalQuery, params);
    const total = parseInt(totalRes.rows[0].total);
    
    // Get rows - note: for deep offsets, this may be slow but with indexes on ts it helps somewhat
    const rowsQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${where}
      ORDER BY ts DESC 
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    params.push(limit, offset);
    
    const rowsRes = await db.query(rowsQuery, params);
    
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
    
    const perSeverity = {};
    SEVERITIES.forEach(s => perSeverity[s] = 0);
    sevRes.rows.forEach(row => {
      perSeverity[row.severity] = parseInt(row.count);
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
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);