const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const dbPath = path.join(__dirname, 'pgdata');
const db = new PGlite(dbPath);

async function initDb() {
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

  const res = await db.query('SELECT COUNT(*) as count FROM logs');
  const count = parseInt(res.rows[0].count, 10);

  if (count < 100000) {
    console.log('Seeding database...');
    await db.exec('TRUNCATE TABLE logs RESTART IDENTITY;');
    
    const services = ['auth-service', 'billing-service', 'api-gateway', 'user-service', 'notification-service', 'search-service', 'inventory-service', 'payment-service'];
    
    let seed = 12345;
    function random() {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    }

    function getSeverity() {
      const r = random();
      if (r < 0.60) return 'debug';
      if (r < 0.85) return 'info';
      if (r < 0.95) return 'warn';
      return 'error';
    }

    const templates = [
      "User {user_id} logged in successfully",
      "Failed to authenticate user {user_id}",
      "Payment of {amount} processed for account {account_id}",
      "Connection timeout to database {db_name}",
      "Cache miss for key {cache_key}",
      "Retrying request to {external_service}",
      "Disk space running low on volume {volume}",
      "Worker {worker_id} started processing job {job_id}"
    ];

    function getMessage() {
      const template = templates[Math.floor(random() * templates.length)];
      return template
        .replace('{user_id}', Math.floor(random() * 10000))
        .replace('{amount}', (random() * 1000).toFixed(2))
        .replace('{account_id}', Math.floor(random() * 5000))
        .replace('{db_name}', 'db-' + Math.floor(random() * 5))
        .replace('{cache_key}', 'key-' + Math.floor(random() * 100000))
        .replace('{external_service}', 'svc-' + Math.floor(random() * 10))
        .replace('{volume}', 'vol-' + Math.floor(random() * 3))
        .replace('{worker_id}', Math.floor(random() * 20))
        .replace('{job_id}', Math.floor(random() * 50000));
    }

    const BATCH_SIZE = 5000;
    const TOTAL_ROWS = 100000;
    const START_TIME = new Date('2023-01-01T00:00:00Z').getTime();
    const END_TIME = START_TIME + 30 * 24 * 60 * 60 * 1000;

    for (let i = 0; i < TOTAL_ROWS; i += BATCH_SIZE) {
      let values = [];
      for (let j = 0; j < BATCH_SIZE; j++) {
        const ts = new Date(START_TIME + random() * (END_TIME - START_TIME)).toISOString();
        const severity = getSeverity();
        const service = services[Math.floor(random() * services.length)];
        const message = getMessage();
        const escapedMessage = message.replace(/'/g, "''");
        values.push(`('${ts}', '${severity}', '${service}', '${escapedMessage}')`);
      }
      await db.exec(`INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')};`);
    }

    console.log('Creating indexes...');
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs(severity, ts DESC);
    `);
    console.log('Database seeded and indexed.');
  } else {
    console.log('Database already seeded.');
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
    if (isNaN(limit) || limit < 0 || limit > 200) {
      return res.status(400).json({ error: 'Invalid limit' });
    }
    if (severity && !['debug', 'info', 'warn', 'error'].includes(severity)) {
      return res.status(400).json({ error: 'Invalid severity' });
    }

    let conditions = [];
    let params = [];
    let paramIndex = 1;

    if (severity) {
      conditions.push(`severity = $${paramIndex++}`);
      params.push(severity);
    }
    if (q) {
      conditions.push(`message ILIKE $${paramIndex++}`);
      params.push(`%${q}%`);
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countQuery = `SELECT COUNT(*) as total FROM logs ${whereClause}`;
    const dataQuery = `
      SELECT * FROM logs 
      ${whereClause} 
      ORDER BY ts DESC 
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;

    const [countRes, dataRes] = await Promise.all([
      db.query(countQuery, params.slice(0, paramIndex - 3)),
      db.query(dataQuery, [...params, limit, offset])
    ]);

    res.json({
      total: parseInt(countRes.rows[0].total, 10),
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
    const severityRes = await db.query('SELECT severity, COUNT(*) as count FROM logs GROUP BY severity');
    
    const counts = {
      debug: 0,
      info: 0,
      warn: 0,
      error: 0
    };
    
    for (const row of severityRes.rows) {
      counts[row.severity] = parseInt(row.count, 10);
    }

    res.json({
      total: parseInt(totalRes.rows[0].total, 10),
      counts
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3001;

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Backend listening on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database', err);
  process.exit(1);
});
