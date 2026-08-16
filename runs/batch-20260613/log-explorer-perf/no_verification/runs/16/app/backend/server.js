const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const dbPath = path.join(__dirname, 'pglite-data');
let db;

async function initDb() {
  db = new PGlite(dbPath);
  await db.waitReady;
  
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity VARCHAR(10) NOT NULL,
      service VARCHAR(50) NOT NULL,
      message TEXT NOT NULL
    );
  `);

  const res = await db.query(`SELECT count(*) as count FROM logs`);
  const count = parseInt(res.rows[0].count, 10);

  if (count === 0) {
    console.log('Seeding database...');
    await seedDb();
    console.log('Seeding complete.');
  } else {
    console.log(`Database already seeded with ${count} rows.`);
  }

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);
  `);
  
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops);`);
  } catch (e) {
    console.log('pg_trgm not available, skipping trigram index');
  }
}

async function seedDb() {
  const severities = ['debug', 'info', 'warn', 'error'];
  const services = ['auth', 'api', 'worker', 'db', 'cache', 'frontend', 'billing', 'search'];
  const templates = [
    "User {user} logged in",
    "Failed to connect to {service}",
    "Processed {count} records in {time}ms",
    "Disk usage at {percent}%",
    "Cache miss for key {key}",
    "Invalid payload received from {ip}",
    "Starting job {job}",
    "Job {job} completed successfully"
  ];

  const now = new Date('2023-01-31T00:00:00Z').getTime();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const startTs = now - thirtyDaysMs;

  let seed = 12345;
  function random() {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  }

  function getRandomItem(arr) {
    return arr[Math.floor(random() * arr.length)];
  }

  function getSeverity() {
    const r = random();
    if (r < 0.6) return 'info';
    if (r < 0.85) return 'debug';
    if (r < 0.95) return 'warn';
    return 'error';
  }

  const batchSize = 5000;
  for (let i = 0; i < 100000; i += batchSize) {
    let values = [];
    for (let j = 0; j < batchSize; j++) {
      const ts = new Date(startTs + random() * thirtyDaysMs).toISOString();
      const severity = getSeverity();
      const service = getRandomItem(services);
      let message = getRandomItem(templates);
      message = message.replace('{user}', 'user_' + Math.floor(random() * 10000));
      message = message.replace('{service}', getRandomItem(services));
      message = message.replace('{count}', Math.floor(random() * 1000));
      message = message.replace('{time}', Math.floor(random() * 500));
      message = message.replace('{percent}', Math.floor(random() * 100));
      message = message.replace('{key}', 'key_' + Math.floor(random() * 100000));
      message = message.replace('{ip}', \`192.168.\${Math.floor(random() * 255)}.\${Math.floor(random() * 255)}\`);
      message = message.replace('{job}', 'job_' + Math.floor(random() * 1000));
      
      message = message.replace(/'/g, "''");
      
      values.push(`('${ts}', '${severity}', '${service}', '${message}')`);
    }
    await db.exec(`INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')}`);
  }
}

initDb().catch(console.error);

app.get('/api/logs', async (req, res) => {
  try {
    let { offset = 0, limit = 50, severity, q } = req.query;
    offset = parseInt(offset, 10);
    limit = parseInt(limit, 10);

    if (isNaN(offset) || offset < 0) return res.status(400).json({ error: 'Invalid offset' });
    if (isNaN(limit) || limit < 0 || limit > 200) return res.status(400).json({ error: 'Invalid limit' });
    if (severity && !['debug', 'info', 'warn', 'error'].includes(severity)) {
      return res.status(400).json({ error: 'Invalid severity' });
    }

    let conditions = [];
    let params = [];
    let paramIdx = 1;

    if (severity) {
      conditions.push(`severity = $${paramIdx++}`);
      params.push(severity);
    }

    if (q) {
      conditions.push(`message ILIKE $${paramIdx++}`);
      params.push(`%${q}%`);
    }

    let whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countQuery = `SELECT count(*) as total FROM logs ${whereClause}`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].total, 10);

    const dataQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${whereClause} 
      ORDER BY ts DESC 
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    const dataParams = [...params, limit, offset];
    const dataRes = await db.query(dataQuery, dataParams);

    res.json({ total, rows: dataRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const totalRes = await db.query(`SELECT count(*) as total FROM logs`);
    const total = parseInt(totalRes.rows[0].total, 10);

    const sevRes = await db.query(`SELECT severity, count(*) as count FROM logs GROUP BY severity`);
    const counts = { debug: 0, info: 0, warn: 0, error: 0 };
    sevRes.rows.forEach(row => {
      counts[row.severity] = parseInt(row.count, 10);
    });

    res.json({ total, counts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
