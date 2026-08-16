import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const DB_PATH = path.join(__dirname, 'data');

app.use(cors());
app.use(express.json());

let db;

const SERVICES = ['auth', 'payment', 'user', 'order', 'inventory', 'notification', 'analytics', 'gateway'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_WEIGHTS = [0.60, 0.25, 0.10, 0.05];

const MESSAGE_TEMPLATES = [
  'User {id} logged in from {ip}',
  'Payment of ${amount} processed for order {orderId}',
  'Failed to connect to {service} service',
  'Cache miss for key {key}',
  'Request {reqId} took {time}ms',
  'Database query returned {count} results',
  'Session expired for user {userId}',
  'Rate limit exceeded for IP {ip}',
  'New order {orderId} created',
  'Inventory updated for product {productId}',
];

function seededRandom(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function generateDeterministicLog(index) {
  const seed = index * 123456789;
  const rand = (s) => seededRandom(seed + s);
  
  const ts = new Date(Date.now() - (30 * 24 * 60 * 60 * 1000) * rand(1)).toISOString();
  
  let cum = 0;
  let severity = SEVERITIES[0];
  const r = rand(2);
  for (let i = 0; i < SEVERITIES.length; i++) {
    cum += SEVERITY_WEIGHTS[i];
    if (r <= cum) {
      severity = SEVERITIES[i];
      break;
    }
  }
  
  const service = SERVICES[Math.floor(rand(3) * SERVICES.length)];
  
  const template = MESSAGE_TEMPLATES[Math.floor(rand(4) * MESSAGE_TEMPLATES.length)];
  const message = template
    .replace('{id}', Math.floor(rand(5) * 10000))
    .replace('{ip}', `192.168.${Math.floor(rand(6)*255)}.${Math.floor(rand(7)*255)}`)
    .replace('{amount}', (rand(8) * 1000).toFixed(2))
    .replace('{orderId}', 'ORD-' + Math.floor(rand(9) * 100000))
    .replace('{service}', SERVICES[Math.floor(rand(10) * SERVICES.length)])
    .replace('{key}', 'cache:' + Math.floor(rand(11) * 1000))
    .replace('{reqId}', 'req-' + Math.floor(rand(12) * 1000000))
    .replace('{time}', Math.floor(rand(13) * 5000))
    .replace('{count}', Math.floor(rand(14) * 1000))
    .replace('{userId}', Math.floor(rand(15) * 10000))
    .replace('{productId}', 'PROD-' + Math.floor(rand(16) * 5000));
  
  return { ts, severity, service, message };
}

async function initializeDatabase() {
  await fs.mkdir(DB_PATH, { recursive: true });
  
  db = new PGlite(DB_PATH);
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
  const rowCount = parseInt(countRes.rows[0].count);
  
  if (rowCount === 0) {
    console.log('Seeding 100,000 log entries...');
    const startTime = Date.now();
    
    const BATCH_SIZE = 1000;
    const TOTAL_ROWS = 100000;
    
    for (let batch = 0; batch < TOTAL_ROWS / BATCH_SIZE; batch++) {
      const values = [];
      const params = [];
      let paramIndex = 1;
      
      for (let i = 0; i < BATCH_SIZE; i++) {
        const logIndex = batch * BATCH_SIZE + i;
        const log = generateDeterministicLog(logIndex);
        values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
        params.push(log.ts, log.severity, log.service, log.message);
      }
      
      const query = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`;
      await db.query(query, params);
      
      if (batch % 10 === 0) {
        console.log(`Seeded ${batch * BATCH_SIZE} rows...`);
      }
    }
    
    console.log(`Seeding completed in ${(Date.now() - startTime) / 1000}s`);
  } else {
    console.log(`Database already seeded with ${rowCount} rows. Skipping seed.`);
  }
  
  // Create indexes
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_message ON logs USING gin (to_tsvector('simple', message));
  `);
  
  console.log('Indexes created/verified.');
}

function validateParams(req, res, next) {
  const { offset, limit, severity } = req.query;
  
  if (offset !== undefined) {
    const off = parseInt(offset);
    if (isNaN(off) || off < 0) {
      return res.status(400).json({ error: 'Invalid offset: must be non-negative integer' });
    }
  }
  
  if (limit !== undefined) {
    const lim = parseInt(limit);
    if (isNaN(lim) || lim < 1 || lim > 200) {
      return res.status(400).json({ error: 'Invalid limit: must be between 1 and 200' });
    }
  }
  
  if (severity !== undefined && severity !== '') {
    if (!['debug', 'info', 'warn', 'error'].includes(severity)) {
      return res.status(400).json({ error: 'Invalid severity' });
    }
  }
  
  next();
}

app.get('/api/logs', validateParams, async (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: 'Server still initializing, please wait' });
  }
  try {
    const offset = parseInt(req.query.offset) || 0;
    const limit = Math.min(parseInt(req.query.limit) || 100, 200);
    const severity = req.query.severity || '';
    const q = req.query.q || '';
    
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
    
    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM logs ${where}`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].total);
    
    // Get rows
    const dataQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${where}
      ORDER BY ts DESC 
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
    params.push(limit, offset);
    
    const dataRes = await db.query(dataQuery, params);
    
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
  if (!dbReady) {
    return res.status(503).json({ error: 'Server still initializing, please wait' });
  }
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

let dbReady = false;

async function startServer() {
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
  
  // Seed in background
  initializeDatabase().then(() => {
    dbReady = true;
    console.log('Database ready for queries.');
  }).catch(console.error);
}

startServer().catch(console.error);