import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

let db;

const SERVICES = ['api', 'auth', 'db', 'cache', 'queue', 'worker', 'frontend', 'billing'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_WEIGHTS = [0.6, 0.25, 0.1, 0.05];
const MESSAGE_TEMPLATES = [
  'User {id} performed action {action} from IP {ip}',
  'Request to {endpoint} completed in {time}ms',
  'Cache {op} for key {key} {result}',
  'Database query {query} returned {rows} rows',
  'Queue job {job} {status} after {duration}s',
  'Auth attempt for user {user} {outcome}',
  'Worker processed batch of size {size} with {errors} errors',
  'Frontend rendered page {page} in {time}ms'
];

function seededRandom(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function generateDeterministicLogs(count) {
  const logs = [];
  const startTime = new Date('2024-01-01T00:00:00Z').getTime();
  const endTime = new Date('2024-01-31T23:59:59Z').getTime();
  const timeRange = endTime - startTime;

  for (let i = 0; i < count; i++) {
    const seed = i * 12345;
    const ts = new Date(startTime + Math.floor(seededRandom(seed) * timeRange));
    const sevRand = seededRandom(seed + 1);
    let severity;
    let cum = 0;
    for (let j = 0; j < SEVERITIES.length; j++) {
      cum += SEVERITY_WEIGHTS[j];
      if (sevRand < cum) {
        severity = SEVERITIES[j];
        break;
      }
    }
    const service = SERVICES[Math.floor(seededRandom(seed + 2) * SERVICES.length)];
    const template = MESSAGE_TEMPLATES[Math.floor(seededRandom(seed + 3) * MESSAGE_TEMPLATES.length)];
    const message = template
      .replace('{id}', Math.floor(seededRandom(seed + 4) * 10000))
      .replace('{action}', ['login', 'logout', 'update', 'delete'][Math.floor(seededRandom(seed + 5) * 4)])
      .replace('{ip}', `192.168.${Math.floor(seededRandom(seed + 6) * 255)}.${Math.floor(seededRandom(seed + 7) * 255)}`)
      .replace('{endpoint}', ['/users', '/orders', '/products', '/search'][Math.floor(seededRandom(seed + 8) * 4)])
      .replace('{time}', Math.floor(seededRandom(seed + 9) * 500))
      .replace('{op}', ['hit', 'miss', 'evict'][Math.floor(seededRandom(seed + 10) * 3)])
      .replace('{key}', `key_${Math.floor(seededRandom(seed + 11) * 1000)}`)
      .replace('{result}', ['success', 'failed'][Math.floor(seededRandom(seed + 12) * 2)])
      .replace('{query}', ['SELECT *', 'INSERT', 'UPDATE'][Math.floor(seededRandom(seed + 13) * 3)])
      .replace('{rows}', Math.floor(seededRandom(seed + 14) * 100))
      .replace('{job}', `job_${Math.floor(seededRandom(seed + 15) * 100)}`)
      .replace('{status}', ['completed', 'failed', 'retry'][Math.floor(seededRandom(seed + 16) * 3)])
      .replace('{duration}', (seededRandom(seed + 17) * 10).toFixed(2))
      .replace('{user}', `user_${Math.floor(seededRandom(seed + 18) * 5000)}`)
      .replace('{outcome}', ['succeeded', 'failed', 'blocked'][Math.floor(seededRandom(seed + 19) * 3)])
      .replace('{size}', Math.floor(seededRandom(seed + 20) * 1000))
      .replace('{errors}', Math.floor(seededRandom(seed + 21) * 5))
      .replace('{page}', ['dashboard', 'profile', 'settings', 'home'][Math.floor(seededRandom(seed + 22) * 4)]);

    logs.push({ ts: ts.toISOString(), severity, service, message });
  }
  return logs;
}

async function initializeDatabase() {
  db = new PGlite('./pgdata');
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

  const countResult = await db.query('SELECT COUNT(*) as count FROM logs');
  const rowCount = parseInt(countResult.rows[0].count);

  if (rowCount === 0) {
    console.log('Seeding 100,000 log entries...');
    const logs = generateDeterministicLogs(100000);
    
    // Batch insert
    const batchSize = 1000;
    for (let i = 0; i < logs.length; i += batchSize) {
      const batch = logs.slice(i, i + batchSize);
      const values = batch.map((log, idx) => {
        const baseIdx = i + idx;
        return `('${log.ts}', '${log.severity}', '${log.service}', '${log.message.replace(/'/g, "''")}')`;
      }).join(',');
      
      await db.exec(`
        INSERT INTO logs (ts, severity, service, message) 
        VALUES ${values}
      `);
      if (i % 10000 === 0) {
        console.log(`Seeded ${i + batch.length} rows...`);
      }
    }
    console.log('Seeding complete.');
  } else {
    console.log(`Database already has ${rowCount} rows, skipping seed.`);
  }

  // Create indexes
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_message ON logs (message);'); // for substring, though not perfect

  console.log('Indexes created.');
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
  
  if (severity !== undefined && severity !== '' && !['debug', 'info', 'warn', 'error'].includes(severity)) {
    res.status(400).json({ error: 'Invalid severity' });
    return false;
  }
  
  return true;
}

app.get('/api/logs', async (req, res) => {
  if (!validateParams(req, res)) return;

  const offset = parseInt(req.query.offset) || 0;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
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
    const countQuery = `SELECT COUNT(*) as total FROM logs ${where}`;
    const countResult = await db.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total);

    // Get rows
    const dataQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${where} 
      ORDER BY ts DESC 
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    params.push(limit, offset);
    const dataResult = await db.query(dataQuery, params);

    res.json({ total, rows: dataResult.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const totalResult = await db.query('SELECT COUNT(*) as total FROM logs');
    const total = parseInt(totalResult.rows[0].total);

    const sevResult = await db.query(`
      SELECT severity, COUNT(*) as count 
      FROM logs 
      GROUP BY severity
    `);
    const perSeverity = {};
    SEVERITIES.forEach(s => perSeverity[s] = 0);
    sevResult.rows.forEach(row => {
      perSeverity[row.severity] = parseInt(row.count);
    });

    res.json({ total, perSeverity });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function startServer() {
  await initializeDatabase();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);