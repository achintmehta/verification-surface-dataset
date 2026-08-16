import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

let db = null;
let isSeeded = false;

const SERVICES = ['api-gateway', 'auth-service', 'user-service', 'payment-service', 'notification-service', 'analytics-service', 'search-service', 'cdn-service'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_WEIGHTS = [0.6, 0.25, 0.1, 0.05]; // cumulative for distribution

const MESSAGE_TEMPLATES = [
  'User {userId} logged in from {ip}',
  'Request to {endpoint} completed in {ms}ms',
  'Database query {query} returned {rows} rows',
  'Cache {action} for key {key}',
  'Payment {status} for order {orderId}',
  'Notification sent to {userId} via {channel}',
  'Search query "{query}" returned {results} results',
  'File {action} {filename} size {size}KB',
  'Session {sessionId} expired',
  'Rate limit exceeded for IP {ip}'
];

function seededRandom(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function getDeterministicLog(index) {
  const totalDays = 30;
  const baseTime = Date.now() - (totalDays * 24 * 60 * 60 * 1000);
  const timeSpread = (totalDays * 24 * 60 * 60 * 1000);
  
  // Deterministic timestamp, newer first for variety but we'll sort
  const tsOffset = Math.floor(seededRandom(index * 1.1) * timeSpread);
  const ts = new Date(baseTime + tsOffset).toISOString();
  
  // Severity based on weighted dist
  const r = seededRandom(index * 2.3);
  let severity;
  let cum = 0;
  for (let i = 0; i < SEVERITIES.length; i++) {
    cum += SEVERITY_WEIGHTS[i];
    if (r <= cum) {
      severity = SEVERITIES[i];
      break;
    }
  }
  if (!severity) severity = 'info';
  
  const service = SERVICES[index % SERVICES.length];
  
  // Message
  const templateIdx = index % MESSAGE_TEMPLATES.length;
  let message = MESSAGE_TEMPLATES[templateIdx];
  message = message
    .replace('{userId}', 'u' + (1000 + (index % 9000)))
    .replace('{ip}', `192.168.${index % 256}.${(index * 7) % 256}`)
    .replace('{endpoint}', ['/users', '/orders', '/products', '/search'][index % 4])
    .replace('{ms}', String(5 + (index % 200)))
    .replace('{rows}', String(1 + (index % 500)))
    .replace('{query}', ['SELECT *', 'UPDATE users', 'INSERT INTO logs'][index % 3])
    .replace('{action}', ['hit', 'miss', 'evict', 'set'][index % 4])
    .replace('{key}', 'cache:' + (index % 10000))
    .replace('{status}', ['success', 'failed', 'pending'][index % 3])
    .replace('{orderId}', 'ord' + (100000 + index % 900000))
    .replace('{channel}', ['email', 'sms', 'push'][index % 3])
    .replace('{results}', String(index % 1000))
    .replace('{filename}', ['report.pdf', 'data.csv', 'image.png'][index % 3])
    .replace('{size}', String(10 + index % 5000))
    .replace('{sessionId}', 'sess' + (index % 100000))
    .replace('{query}', 'term' + (index % 500));
  
  // Add some variable fragments for search selectivity
  if (index % 17 === 0) message += ' critical error trace';
  if (index % 23 === 0) message += ' timeout waiting for response';
  if (index % 37 === 0) message += ' connection refused';
  
  const id = index + 1;
  
  return { id, ts, severity, service, message };
}

async function initializeDatabase() {
  console.log('Initializing PGLite...');
  db = new PGlite('./.pglite');
  await db.waitReady;
  
  // Create table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
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
    const startTime = Date.now();
    
    const BATCH_SIZE = 1000;
    const TOTAL_ROWS = 100000;
    
    for (let batchStart = 0; batchStart < TOTAL_ROWS; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL_ROWS);
      const values = [];
      const params = [];
      let paramIdx = 1;
      
      for (let i = batchStart; i < batchEnd; i++) {
        const log = getDeterministicLog(i);
        values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
        params.push(log.id, log.ts, log.severity, log.service, log.message);
      }
      
      const query = `INSERT INTO logs (id, ts, severity, service, message) VALUES ${values.join(', ')}`;
      await db.query(query, params);
      
      if (batchStart % 10000 === 0) {
        console.log(`Seeded ${batchStart + BATCH_SIZE} rows...`);
      }
    }
    
    const seedTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Seeding completed in ${seedTime}s`);
    
    // Create indexes after seeding for better perf
    console.log('Creating indexes...');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_service ON logs (service);');
    
    console.log('Indexes created.');
  } else {
    console.log(`Database already seeded with ${count} rows. Skipping seed.`);
  }
  
  isSeeded = true;
  console.log('Database ready.');
}

async function queryLogs({ offset = 0, limit = 100, severity, q }) {
  let whereClauses = [];
  let params = [];
  let paramIdx = 1;
  
  if (severity) {
    whereClauses.push(`severity = $${paramIdx++}`);
    params.push(severity);
  }
  
  if (q && q.trim()) {
    whereClauses.push(`message ILIKE $${paramIdx++}`);
    params.push(`%${q.trim()}%`);
  }
  
  const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
  
  // Total count
  const countQuery = `SELECT COUNT(*) as total FROM logs ${where}`;
  const countRes = await db.query(countQuery, params);
  const total = parseInt(countRes.rows[0].total);
  
  // Rows with limit/offset, ordered ts DESC
  const dataQuery = `
    SELECT id, ts, severity, service, message 
    FROM logs 
    ${where} 
    ORDER BY ts DESC 
    LIMIT $${paramIdx++} OFFSET $${paramIdx++}
  `;
  params.push(Math.min(limit, 200), offset);
  
  const dataRes = await db.query(dataQuery, params);
  
  return { total, rows: dataRes.rows };
}

async function getStats() {
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
  
  return { total, perSeverity };
}

// Initialize DB on start
initializeDatabase().catch(console.error);

// API Routes
app.get('/api/logs', async (req, res) => {
  try {
    if (!isSeeded || !db) {
      return res.status(503).json({ error: 'Database not ready' });
    }
    
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 100;
    const severity = req.query.severity;
    const q = req.query.q;
    
    // Validation
    if (offset < 0) {
      return res.status(400).json({ error: 'offset must be non-negative' });
    }
    if (limit > 200 || limit < 1) {
      return res.status(400).json({ error: 'limit must be between 1 and 200' });
    }
    if (severity && !SEVERITIES.includes(severity)) {
      return res.status(400).json({ error: 'invalid severity' });
    }
    
    const result = await queryLogs({ offset, limit, severity, q });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    if (!isSeeded || !db) {
      return res.status(503).json({ error: 'Database not ready' });
    }
    const stats = await getStats();
    res.json(stats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});