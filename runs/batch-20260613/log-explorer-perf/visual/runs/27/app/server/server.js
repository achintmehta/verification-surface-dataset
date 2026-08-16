import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

let db;

const SERVICES = ['api', 'auth', 'db', 'cache', 'worker', 'frontend', 'gateway', 'scheduler'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_WEIGHTS = [0.60, 0.25, 0.10, 0.05];

function mulberry32(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function getSeverity(randVal) {
  let cum = 0;
  for (let i = 0; i < SEVERITIES.length; i++) {
    cum += SEVERITY_WEIGHTS[i];
    if (randVal < cum) return SEVERITIES[i];
  }
  return 'debug';
}

const MESSAGE_TEMPLATES = [
  "Request from user {id} completed in {time}ms",
  "Failed to connect to {service} for request {id}",
  "Cache {action} for key {key} took {time}ms",
  "Database query {query} returned {rows} rows",
  "Worker processed job {id} with status {status}",
  "Auth token {action} for user {id}",
  "Gateway routed request to {service}",
  "Scheduler started task {task} at {time}"
];

async function seedIfNeeded() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL,
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);

  const countRes = await db.query('SELECT COUNT(*)::int as count FROM logs');
  if (countRes.rows[0].count > 0) {
    console.log('Database already seeded, skipping.');
    return;
  }

  console.log('Seeding 100,000 log entries...');
  const startTime = Date.now();
  const rand = mulberry32(42);
  const BATCH_SIZE = 2000;
  const TOTAL_ROWS = 100000;
  const now = Date.now();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);');
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);');

  for (let batch = 0; batch < TOTAL_ROWS; batch += BATCH_SIZE) {
    const batchSize = Math.min(BATCH_SIZE, TOTAL_ROWS - batch);
    const placeholders = [];
    const params = [];
    let p = 1;
    for (let i = 0; i < batchSize; i++) {
      const globalIdx = batch + i;
      const r = rand();
      const severity = getSeverity(r);
      const service = SERVICES[Math.floor(rand() * SERVICES.length)];
      const tsOffset = Math.floor((globalIdx / TOTAL_ROWS) * THIRTY_DAYS_MS);
      const ts = new Date(now - tsOffset).toISOString();

      const tmplIdx = globalIdx % MESSAGE_TEMPLATES.length;
      let message = MESSAGE_TEMPLATES[tmplIdx];
      const fragSeed = globalIdx * 17 + Math.floor(r * 1000);
      message = message.replace(/\{(\w+)\}/g, (_, key) => {
        const v = fragSeed % 10000;
        switch (key) {
          case 'id': return (fragSeed % 100000);
          case 'time': return 5 + (v % 450);
          case 'service': return SERVICES[v % SERVICES.length];
          case 'action': return ['created', 'updated', 'deleted', 'fetched', 'validated'][v % 5];
          case 'key': return 'key_' + (v % 10000);
          case 'query': return ['SELECT * FROM', 'INSERT INTO', 'UPDATE', 'DELETE FROM'][v % 4];
          case 'rows': return v % 800;
          case 'status': return ['success', 'pending', 'failed', 'retry'][v % 4];
          case 'task': return 'task_' + (v % 300);
          default: return 'val';
        }
      });

      placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(ts, severity, service, message);
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${placeholders.join(', ')}`;
    await db.query(sql, params);
    if ((batch + batchSize) % 20000 === 0) {
      console.log(`Seeded ${batch + batchSize} rows...`);
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Seeding completed in ${duration}s`);
}

async function initDB() {
  db = new PGlite('file://./pgdata');
  await db.waitReady;
  await seedIfNeeded();
  console.log('DB initialized');
}

async function startServer() {
  await initDB();

  app.get('/api/logs', async (req, res) => {
    try {
      const offset = parseInt(req.query.offset) || 0;
      let limit = parseInt(req.query.limit) || 100;
      if (limit > 200) limit = 200;
      const severity = req.query.severity;
      const q = req.query.q;

      if (offset < 0 || limit < 1) {
        return res.status(400).json({ error: 'Invalid offset or limit' });
      }
      if (severity && !SEVERITIES.includes(severity)) {
        return res.status(400).json({ error: 'Unknown severity' });
      }

      let whereClauses = [];
      const params = [];
      let p = 1;

      if (severity) {
        whereClauses.push(`severity = $${p++}`);
        params.push(severity);
      }
      if (q && q.length > 0) {
        whereClauses.push(`message ILIKE $${p++}`);
        params.push(`%${q}%`);
      }
      const where = whereClauses.length ? 'WHERE ' + whereClauses.join(' AND ') : '';

      const countSql = `SELECT COUNT(*)::int as total FROM logs ${where}`;
      const countRes = await db.query(countSql, params);
      const total = countRes.rows[0].total;

      const dataParams = [...params, limit, offset];
      const dataSql = `
        SELECT id, ts, severity, service, message 
        FROM logs 
        ${where} 
        ORDER BY ts DESC 
        LIMIT $${p++} OFFSET $${p++}
      `;
      const dataRes = await db.query(dataSql, dataParams);

      res.json({ total, rows: dataRes.rows });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Query failed' });
    }
  });

  app.get('/api/stats', async (req, res) => {
    try {
      const totalRes = await db.query('SELECT COUNT(*)::int as total FROM logs');
      const total = totalRes.rows[0].total;

      const sevRes = await db.query('SELECT severity, COUNT(*)::int as count FROM logs GROUP BY severity');
      const perSeverity = {};
      SEVERITIES.forEach(s => { perSeverity[s] = 0; });
      sevRes.rows.forEach(r => { perSeverity[r.severity] = r.count; });

      res.json({ total, perSeverity });
    } catch (err) {
      res.status(500).json({ error: 'Stats failed' });
    }
  });

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);