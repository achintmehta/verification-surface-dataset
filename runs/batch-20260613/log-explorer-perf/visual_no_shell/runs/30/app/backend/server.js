import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'logs.db');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

let db = null;

const SERVICES = ['auth', 'payment', 'user', 'order', 'inventory', 'notification', 'analytics', 'gateway'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_WEIGHTS = [0.25, 0.60, 0.10, 0.05]; // debug, info, warn, error

// Deterministic PRNG
function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

const MESSAGE_TEMPLATES = [
  "User {userId} logged in from {ip}",
  "Payment {amount} processed for order {orderId}",
  "Failed to connect to {service} service",
  "Cache miss for key {key}",
  "Request {reqId} completed in {time}ms",
  "Error in {module}: {errorMsg}",
  "Scheduled job {jobName} started",
  "Database query took {time}ms on table {table}"
];

const VAR_FRAGMENTS = {
  userId: (i) => `u${100000 + (i % 50000)}`,
  ip: (i) => `192.168.${(i % 256)}.${((i * 7) % 256)}`,
  amount: (i) => (100 + (i % 9000)).toString(),
  orderId: (i) => `ord-${1000000 + (i % 100000)}`,
  service: (i) => SERVICES[i % SERVICES.length],
  key: (i) => `cache:${(i % 10000)}`,
  reqId: (i) => `req-${i}`,
  time: (i) => (5 + (i % 500)).toString(),
  module: (i) => ['auth', 'db', 'api', 'worker'][i % 4],
  errorMsg: (i) => ['timeout', 'connection refused', 'invalid token', 'not found'][i % 4],
  jobName: (i) => ['cleanup', 'report', 'sync', 'backup'][i % 4],
  table: (i) => ['users', 'orders', 'logs', 'events'][i % 4]
};

function generateMessage(i) {
  const template = MESSAGE_TEMPLATES[i % MESSAGE_TEMPLATES.length];
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    if (VAR_FRAGMENTS[key]) {
      return VAR_FRAGMENTS[key](i);
    }
    return match;
  });
}

async function initDb() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  
  db = new PGlite(DB_PATH);
  await db.waitReady;

  // Create table
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
  const rowCount = parseInt(countRes.rows[0].count);

  if (rowCount === 0) {
    console.log('Seeding 100,000 log entries...');
    const startTime = Date.now();
    
    const BATCH_SIZE = 1000;
    const TOTAL_ROWS = 100000;
    const START_DATE = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
    
    const rand = seededRandom(42); // deterministic seed

    for (let batch = 0; batch < TOTAL_ROWS / BATCH_SIZE; batch++) {
      const values = [];
      const params = [];
      let paramIndex = 1;

      for (let i = 0; i < BATCH_SIZE; i++) {
        const globalIndex = batch * BATCH_SIZE + i;
        
        // Timestamp: spread over 30 days, deterministic
        const dayOffset = Math.floor(globalIndex / (TOTAL_ROWS / 30));
        const ts = new Date(START_DATE.getTime() + dayOffset * 24 * 60 * 60 * 1000 + (globalIndex % 86400) * 1000);
        
        // Severity based on weights
        let r = rand();
        let severity = SEVERITIES[0];
        let cum = 0;
        for (let s = 0; s < SEVERITIES.length; s++) {
          cum += SEVERITY_WEIGHTS[s];
          if (r <= cum) {
            severity = SEVERITIES[s];
            break;
          }
        }
        
        const service = SERVICES[globalIndex % SERVICES.length];
        const message = generateMessage(globalIndex);
        
        values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
        params.push(ts.toISOString(), severity, service, message);
      }

      const query = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`;
      await db.query(query, params);
      
      if (batch % 10 === 0) {
        console.log(`Seeded batch ${batch + 1}/${TOTAL_ROWS / BATCH_SIZE}`);
      }
    }
    
    console.log(`Seeding completed in ${Date.now() - startTime}ms`);
  } else {
    console.log(`Database already seeded with ${rowCount} rows`);
  }

  // Create indexes
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_message ON logs (message);'); // helps somewhat

  console.log('Indexes created');
}

function validateParams(req, res) {
  const { offset, limit, severity, q } = req.query;
  
  if (offset !== undefined) {
    const o = parseInt(offset);
    if (isNaN(o) || o < 0) {
      res.status(400).json({ error: 'Invalid offset: must be non-negative integer' });
      return false;
    }
  }
  
  if (limit !== undefined) {
    const l = parseInt(limit);
    if (isNaN(l) || l < 1 || l > 200) {
      res.status(400).json({ error: 'Invalid limit: must be between 1 and 200' });
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
  const severity = req.query.severity || null;
  const q = req.query.q || null;

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

    // Get total
    const countQuery = `SELECT COUNT(*) as total FROM logs ${where}`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].total);

    // Get rows
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