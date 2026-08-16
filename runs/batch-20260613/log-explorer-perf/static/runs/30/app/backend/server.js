import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

let db = null;
let isSeeded = false;

const SERVICES = ['auth', 'api', 'db', 'frontend', 'worker', 'cache', 'queue', 'logger'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_WEIGHTS = [0.60, 0.25, 0.10, 0.05];
const MESSAGE_TEMPLATES = [
  'User {id} logged in from {ip}',
  'Request to {endpoint} completed in {ms}ms',
  'Database query {query} returned {rows} rows',
  'Cache {action} for key {key} {result}',
  'Worker processed job {jobId} with status {status}',
  'Queue {queue} has {count} pending messages',
  'Auth token {action} for user {userId}',
  'Frontend rendered page {page} in {time}ms'
];

function seededRandom(seed) {
  let x = Math.sin(seed++) * 10000;
  return x - Math.floor(x);
}

function getDeterministicValue(seed, max) {
  return Math.floor(seededRandom(seed) * max);
}

async function initializeDatabase() {
  db = new PGlite('./.pglite');
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

  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*) as count FROM logs');
  const rowCount = parseInt(countResult.rows[0].count, 10);

  if (rowCount === 100000) {
    console.log('Database already seeded with 100,000 rows');
    isSeeded = true;
    await createIndexes();
    return;
  }

  if (rowCount > 0) {
    console.log(`Found ${rowCount} rows, clearing and reseeding...`);
    await db.exec('TRUNCATE TABLE logs');
  }

  console.log('Seeding 100,000 log entries...');
  const startTime = Date.now();

  // Seed in batches
  const BATCH_SIZE = 5000;
  const TOTAL_ROWS = 100000;
  const START_DATE = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
  const END_DATE = new Date();

  let inserted = 0;
  let seed = 42; // deterministic seed

  for (let batch = 0; batch < TOTAL_ROWS / BATCH_SIZE; batch++) {
    const values = [];
    const params = [];
    let paramIndex = 1;

    for (let i = 0; i < BATCH_SIZE; i++) {
      const rowSeed = seed + inserted;
      
      // Timestamp: spread over 30 days, deterministic
      const progress = inserted / TOTAL_ROWS;
      const ts = new Date(START_DATE.getTime() + progress * (END_DATE.getTime() - START_DATE.getTime()) + 
                          (seededRandom(rowSeed) - 0.5) * 1000 * 60 * 5); // small jitter

      // Severity based on weights
      let sevRand = seededRandom(rowSeed + 1);
      let severity = SEVERITIES[0];
      let cum = 0;
      for (let s = 0; s < SEVERITIES.length; s++) {
        cum += SEVERITY_WEIGHTS[s];
        if (sevRand <= cum) {
          severity = SEVERITIES[s];
          break;
        }
      }

      // Service
      const service = SERVICES[getDeterministicValue(rowSeed + 2, SERVICES.length)];

      // Message
      const template = MESSAGE_TEMPLATES[getDeterministicValue(rowSeed + 3, MESSAGE_TEMPLATES.length)];
      const message = template
        .replace('{id}', getDeterministicValue(rowSeed + 4, 10000))
        .replace('{ip}', `192.168.${getDeterministicValue(rowSeed + 5, 255)}.${getDeterministicValue(rowSeed + 6, 255)}`)
        .replace('{endpoint}', `/api/v1/resource/${getDeterministicValue(rowSeed + 7, 100)}`)
        .replace('{ms}', getDeterministicValue(rowSeed + 8, 500) + 10)
        .replace('{query}', `SELECT * FROM table_${getDeterministicValue(rowSeed + 9, 20)}`)
        .replace('{rows}', getDeterministicValue(rowSeed + 10, 1000))
        .replace('{action}', ['hit', 'miss', 'evict', 'set'][getDeterministicValue(rowSeed + 11, 4)])
        .replace('{key}', `key_${getDeterministicValue(rowSeed + 12, 10000)}`)
        .replace('{result}', ['success', 'failed', 'timeout'][getDeterministicValue(rowSeed + 13, 3)])
        .replace('{jobId}', `job-${getDeterministicValue(rowSeed + 14, 100000)}`)
        .replace('{status}', ['completed', 'failed', 'retrying'][getDeterministicValue(rowSeed + 15, 3)])
        .replace('{queue}', ['high', 'normal', 'low'][getDeterministicValue(rowSeed + 16, 3)])
        .replace('{count}', getDeterministicValue(rowSeed + 17, 1000))
        .replace('{userId}', getDeterministicValue(rowSeed + 18, 50000))
        .replace('{page}', ['dashboard', 'logs', 'settings', 'profile'][getDeterministicValue(rowSeed + 19, 4)])
        .replace('{time}', getDeterministicValue(rowSeed + 20, 200) + 5);

      values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
      params.push(ts.toISOString(), severity, service, message);
      inserted++;
    }

    const insertQuery = `
      INSERT INTO logs (ts, severity, service, message)
      VALUES ${values.join(', ')}
    `;
    await db.query(insertQuery, params);
    
    if (batch % 4 === 0) {
      console.log(`Seeded ${inserted} rows...`);
    }
  }

  const seedTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Seeding completed in ${seedTime}s`);

  await createIndexes();
  isSeeded = true;
}

async function createIndexes() {
  console.log('Creating indexes...');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC)');
  // For message search, a simple index won't help ILIKE much, but for completeness
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_message ON logs (message)');
  console.log('Indexes created');
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
    if (!SEVERITIES.includes(severity)) {
      res.status(400).json({ error: `Invalid severity: must be one of ${SEVERITIES.join(', ')}` });
      return false;
    }
  }

  return true;
}

app.get('/api/logs', async (req, res) => {
  if (!isSeeded) {
    return res.status(503).json({ error: 'Database not ready' });
  }

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

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM logs ${where}`;
    const countResult = await db.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total, 10);

    // Get rows
    const dataQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${where}
      ORDER BY ts DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
    const dataParams = [...params, limit, offset];
    const dataResult = await db.query(dataQuery, dataParams);

    res.json({
      total,
      rows: dataResult.rows
    });
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
    const totalResult = await db.query('SELECT COUNT(*) as total FROM logs');
    const total = parseInt(totalResult.rows[0].total, 10);

    const sevResult = await db.query(`
      SELECT severity, COUNT(*) as count 
      FROM logs 
      GROUP BY severity
    `);

    const perSeverity = {};
    SEVERITIES.forEach(s => perSeverity[s] = 0);
    sevResult.rows.forEach(row => {
      perSeverity[row.severity] = parseInt(row.count, 10);
    });

    res.json({ total, perSeverity });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Stats query failed' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', seeded: isSeeded });
});

// Initialize and start server
initializeDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});