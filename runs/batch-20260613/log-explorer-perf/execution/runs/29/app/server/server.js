import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

let db;
let isSeeded = false;

const SERVICES = ['auth', 'api', 'db', 'frontend', 'worker', 'cache', 'payment', 'notification'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_WEIGHTS = [0.60, 0.25, 0.10, 0.05];
const MESSAGE_TEMPLATES = [
  'User {0} performed action {1} from IP {2}',
  'Request to {0} completed in {1}ms with status {2}',
  'Cache {0} for key {1} {2}',
  'Database query {0} took {1}ms on table {2}',
  'Worker job {0} {1} for task {2}',
  'Payment {0} processed for amount {1} {2}',
  'Notification sent to {0} via {1} {2}',
  'Auth attempt {0} {1} for user {2}'
];

function seededRandom(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function generateLogEntry(index, total) {
  const seed = index;
  const dayOffset = Math.floor((index / total) * 30);
  const ts = new Date(Date.now() - (30 - dayOffset) * 86400000 - (index % 86400) * 1000);
  
  let cum = 0;
  let sevIdx = 0;
  const r = seededRandom(seed * 7);
  for (let i = 0; i < SEVERITY_WEIGHTS.length; i++) {
    cum += SEVERITY_WEIGHTS[i];
    if (r < cum) {
      sevIdx = i;
      break;
    }
  }
  const severity = SEVERITIES[sevIdx];
  
  const service = SERVICES[index % SERVICES.length];
  
  const tpl = MESSAGE_TEMPLATES[index % MESSAGE_TEMPLATES.length];
  const msg = tpl
    .replace('{0}', (index % 1000).toString())
    .replace('{1}', (100 + (index % 500)).toString())
    .replace('{2}', ['success', 'failed', 'pending', 'retry'][index % 4]);
  
  return { ts: ts.toISOString(), severity, service, message: msg };
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
  const count = parseInt(countRes.rows[0].count);
  
  if (count === 0) {
    console.log('Seeding 100,000 log entries...');
    const start = Date.now();
    const BATCH_SIZE = 1000;
    const TOTAL = 100000;
    
    await db.exec('BEGIN');
    for (let batch = 0; batch < TOTAL / BATCH_SIZE; batch++) {
      const values = [];
      for (let i = 0; i < BATCH_SIZE; i++) {
        const idx = batch * BATCH_SIZE + i;
        const entry = generateLogEntry(idx, TOTAL);
        values.push(`('${entry.ts}', '${entry.severity}', '${entry.service}', '${entry.message.replace(/'/g, "''")}')`);
      }
      await db.exec(`INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')}`);
    }
    await db.exec('COMMIT');
    console.log(`Seeding completed in ${Date.now() - start}ms`);
  } else {
    console.log(`Database already seeded with ${count} rows`);
  }
  
  // Create indexes
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_message ON logs (message text_pattern_ops)'); // for like
  
  isSeeded = true;
}

initDb().catch(console.error);

// Validation helpers
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
  if (!isSeeded) {
    return res.status(503).json({ error: 'Database not ready' });
  }
  
  const params = validateParams(req, res);
  if (!params) return;
  
  const { offset, limit, severity, q } = params;
  
  let where = [];
  let values = [];
  let idx = 1;
  
  if (severity) {
    where.push(`severity = $${idx++}`);
    values.push(severity);
  }
  if (q) {
    where.push(`message ILIKE $${idx++}`);
    values.push(`%${q}%`);
  }
  
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  
  try {
    const countQuery = `SELECT COUNT(*) as total FROM logs ${whereClause}`;
    const countRes = await db.query(countQuery, values);
    const total = parseInt(countRes.rows[0].total);
    
    const dataQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${whereClause}
      ORDER BY ts DESC 
      LIMIT $${idx} OFFSET $${idx + 1}
    `;
    const dataValues = [...values, limit, offset];
    const dataRes = await db.query(dataQuery, dataValues);
    
    res.json({ total, rows: dataRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Query failed' });
  }
});

app.get('/api/stats', async (req, res) => {
  if (!isSeeded) {
    return res.status(503).json({ error: 'Database not ready' });
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
    sevRes.rows.forEach(r => {
      perSeverity[r.severity] = parseInt(r.count);
    });
    
    res.json({ total, perSeverity });
  } catch (err) {
    res.status(500).json({ error: 'Stats failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});