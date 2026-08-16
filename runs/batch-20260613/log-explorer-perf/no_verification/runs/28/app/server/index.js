import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

let db;

const SERVICES = ['auth', 'payment', 'user', 'inventory', 'notification', 'analytics', 'search', 'recommendation'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_WEIGHTS = [0.6, 0.25, 0.1, 0.05];
const MESSAGE_TEMPLATES = [
  'User {id} logged in from {ip}',
  'Payment {amount} processed for order {orderId}',
  'Cache miss for key {key}',
  'Request to {endpoint} took {time}ms',
  'Failed to connect to {service}: {error}',
  'Updated {count} records in {table}',
  'Query executed: SELECT * FROM {table} WHERE id={id}',
  'Session expired for user {userId}',
  'New {item} created with id {id}',
  'Background job {job} completed in {time}s'
];

function seededRandom(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function getDeterministicValue(seed, max) {
  return Math.floor(seededRandom(seed) * max);
}

function generateLogEntry(index) {
  const seed = index * 123456789;
  const now = new Date('2024-01-01T00:00:00Z').getTime();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const ts = new Date(now + getDeterministicValue(seed, thirtyDaysMs));
  
  // severity distribution
  let cum = 0;
  let severity = 'debug';
  const r = seededRandom(seed + 1);
  for (let i = 0; i < SEVERITIES.length; i++) {
    cum += SEVERITY_WEIGHTS[i];
    if (r <= cum) {
      severity = SEVERITIES[i];
      break;
    }
  }
  
  const service = SERVICES[getDeterministicValue(seed + 2, SERVICES.length)];
  
  const template = MESSAGE_TEMPLATES[getDeterministicValue(seed + 3, MESSAGE_TEMPLATES.length)];
  const message = template
    .replace('{id}', getDeterministicValue(seed + 4, 100000))
    .replace('{ip}', `192.168.${getDeterministicValue(seed + 5, 255)}.${getDeterministicValue(seed + 6, 255)}`)
    .replace('{amount}', (getDeterministicValue(seed + 7, 10000) / 100).toFixed(2))
    .replace('{orderId}', getDeterministicValue(seed + 8, 999999))
    .replace('{key}', `cache:${getDeterministicValue(seed + 9, 10000)}`)
    .replace('{endpoint}', `/api/v1/${['users', 'orders', 'products'][getDeterministicValue(seed + 10, 3)]}`)
    .replace('{time}', getDeterministicValue(seed + 11, 5000))
    .replace('{service}', SERVICES[getDeterministicValue(seed + 12, SERVICES.length)])
    .replace('{error}', ['timeout', 'connection refused', 'auth failed'][getDeterministicValue(seed + 13, 3)])
    .replace('{count}', getDeterministicValue(seed + 14, 1000))
    .replace('{table}', ['users', 'orders', 'logs', 'sessions'][getDeterministicValue(seed + 15, 4)])
    .replace('{userId}', getDeterministicValue(seed + 16, 100000))
    .replace('{item}', ['user', 'order', 'product', 'log'][getDeterministicValue(seed + 17, 4)])
    .replace('{job}', ['sync', 'cleanup', 'report', 'index'][getDeterministicValue(seed + 18, 4)]);
  
  return {
    ts: ts.toISOString(),
    severity,
    service,
    message
  };
}

async function initializeDatabase() {
  const dataDir = path.join(__dirname, '.pglite');
  db = new PGlite(dataDir);
  await db.waitReady;
  
  // Check if table exists and has data
  const tableCheck = await db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_name = 'logs'
    );
  `);
  
  const tableExists = tableCheck.rows[0].exists;
  
  if (!tableExists) {
    await db.query(`
      CREATE TABLE logs (
        id SERIAL PRIMARY KEY,
        ts TIMESTAMP NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
        service TEXT NOT NULL,
        message TEXT NOT NULL
      );
    `);
    
    console.log('Seeding 100,000 log entries...');
    const BATCH_SIZE = 1000;
    const TOTAL_ROWS = 100000;
    
    for (let batch = 0; batch < TOTAL_ROWS / BATCH_SIZE; batch++) {
      const values = [];
      const params = [];
      let paramIndex = 1;
      
      for (let i = 0; i < BATCH_SIZE; i++) {
        const entry = generateLogEntry(batch * BATCH_SIZE + i);
        values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
        params.push(entry.ts, entry.severity, entry.service, entry.message);
      }
      
      await db.query(
        `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`,
        params
      );
      
      if (batch % 10 === 0) {
        console.log(`Seeded ${(batch + 1) * BATCH_SIZE} rows...`);
      }
    }
    console.log('Seeding complete.');
  } else {
    const countRes = await db.query('SELECT COUNT(*) FROM logs');
    console.log(`Database already seeded with ${countRes.rows[0].count} rows.`);
  }
  
  // Create indexes
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);');
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);');
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_message ON logs (message text_pattern_ops);'); // for like
  
  console.log('Indexes created.');
}

function validateParams(req, res) {
  const { offset, limit, severity, q } = req.query;
  
  if (offset !== undefined) {
    const off = parseInt(offset, 10);
    if (isNaN(off) || off < 0) {
      res.status(400).json({ error: 'Invalid offset: must be non-negative integer' });
      return false;
    }
  }
  
  if (limit !== undefined) {
    const lim = parseInt(limit, 10);
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
      whereClauses.push(`LOWER(message) LIKE $${paramIndex++}`);
      params.push(`%${q.toLowerCase()}%`);
    }
    
    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    
    // Get total
    const countQuery = `SELECT COUNT(*) as total FROM logs ${where}`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].total, 10);
    
    // Get rows - use ts DESC
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
  await initializeDatabase();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);