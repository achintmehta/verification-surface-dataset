const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const dbPath = path.join(__dirname, 'pgdata');
let db;

async function initDb() {
  db = new PGlite(dbPath);
  await db.waitReady;

  // Check if table exists
  const res = await db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = 'logs'
    );
  `);

  const exists = res.rows[0].exists;

  if (!exists) {
    console.log('Initializing database schema...');
    await db.exec(`
      CREATE TABLE logs (
        id SERIAL PRIMARY KEY,
        ts TIMESTAMP NOT NULL,
        severity VARCHAR(10) NOT NULL,
        service VARCHAR(50) NOT NULL,
        message TEXT NOT NULL
      );
    `);

    console.log('Seeding 100,000 rows...');
    const severities = ['debug', 'info', 'warn', 'error'];
    const services = ['auth', 'api', 'worker', 'db', 'cache', 'search', 'billing', 'notification'];
    const templates = [
      "User {user} logged in successfully",
      "Failed to authenticate user {user}",
      "Processing job {jobId} in queue",
      "Database connection timeout",
      "Cache miss for key {key}",
      "Payment processed for account {account}",
      "Sending email to {email}",
      "Disk space running low on {host}",
      "Invalid request payload: {payload}",
      "Service {service} restarted"
    ];

    // Deterministic random
    let seed = 1;
    function random() {
      const x = Math.sin(seed++) * 10000;
      return x - Math.floor(x);
    }

    function getRandomItem(arr) {
      return arr[Math.floor(random() * arr.length)];
    }

    const batchSize = 5000;
    const totalRows = 100000;
    const now = new Date('2023-01-31T00:00:00Z').getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

    for (let i = 0; i < totalRows; i += batchSize) {
      let values = [];
      for (let j = 0; j < batchSize; j++) {
        const ts = new Date(now - random() * thirtyDaysMs).toISOString();
        
        const r = random();
        let severity = 'debug';
        if (r > 0.6) severity = 'info';
        if (r > 0.85) severity = 'warn';
        if (r > 0.95) severity = 'error';

        const service = getRandomItem(services);
        
        let message = getRandomItem(templates);
        message = message.replace('{user}', 'user_' + Math.floor(random() * 1000));
        message = message.replace('{jobId}', 'job_' + Math.floor(random() * 10000));
        message = message.replace('{key}', 'key_' + Math.floor(random() * 500));
        message = message.replace('{account}', 'acc_' + Math.floor(random() * 100));
        message = message.replace('{email}', 'user' + Math.floor(random() * 1000) + '@example.com');
        message = message.replace('{host}', 'host_' + Math.floor(random() * 10));
        message = message.replace('{payload}', 'data_' + Math.floor(random() * 1000));
        message = message.replace('{service}', getRandomItem(services));

        values.push(`('${ts}', '${severity}', '${service}', '${message.replace(/'/g, "''")}')`);
      }
      
      await db.exec(`
        INSERT INTO logs (ts, severity, service, message)
        VALUES ${values.join(', ')};
      `);
      console.log(`Inserted ${i + batchSize} rows`);
    }

    console.log('Creating indexes...');
    await db.exec(`
      CREATE INDEX idx_logs_ts ON logs (ts DESC);
      CREATE INDEX idx_logs_severity_ts ON logs (severity, ts DESC);
    `);
    console.log('Database initialization complete.');
  } else {
    console.log('Database already initialized.');
  }
}

app.get('/api/logs', async (req, res) => {
  try {
    let { offset = 0, limit = 50, severity, q } = req.query;
    offset = parseInt(offset, 10);
    limit = parseInt(limit, 10);

    if (isNaN(offset) || offset < 0) {
      return res.status(400).json({ error: 'Invalid offset' });
    }
    if (isNaN(limit) || limit < 1 || limit > 200) {
      return res.status(400).json({ error: 'Invalid limit' });
    }

    let conditions = [];
    let params = [];
    let paramIndex = 1;

    if (severity) {
      const validSeverities = ['debug', 'info', 'warn', 'error'];
      if (!validSeverities.includes(severity)) {
        return res.status(400).json({ error: 'Invalid severity' });
      }
      conditions.push(`severity = $${paramIndex++}`);
      params.push(severity);
    }

    if (q) {
      conditions.push(`message ILIKE $${paramIndex++}`);
      params.push(`%${q}%`);
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    // Get total count
    const countQuery = `SELECT COUNT(*) FROM logs ${whereClause}`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].count, 10);

    // Get rows
    const rowsQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${whereClause} 
      ORDER BY ts DESC 
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
    const rowsParams = [...params, limit, offset];
    const rowsRes = await db.query(rowsQuery, rowsParams);

    res.json({ total, rows: rowsRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const totalRes = await db.query('SELECT COUNT(*) FROM logs');
    const total = parseInt(totalRes.rows[0].count, 10);

    const severityRes = await db.query('SELECT severity, COUNT(*) FROM logs GROUP BY severity');
    const counts = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const row of severityRes.rows) {
      counts[row.severity] = parseInt(row.count, 10);
    }

    res.json({ total, counts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database', err);
  process.exit(1);
});
