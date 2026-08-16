const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const dbPath = path.join(__dirname, 'pglite-data');
const db = new PGlite(dbPath);

async function initDb() {
  await db.waitReady;
  
  const res = await db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = 'logs'
    );
  `);
  
  const exists = res.rows[0].exists;
  
  if (!exists) {
    console.log("First boot: Seeding database...");
    await db.query(`
      CREATE TABLE logs (
        id SERIAL PRIMARY KEY,
        ts TIMESTAMP NOT NULL,
        severity VARCHAR(10) NOT NULL,
        service VARCHAR(50) NOT NULL,
        message TEXT NOT NULL
      );
    `);
    
    await db.query(`CREATE INDEX idx_logs_ts ON logs(ts DESC);`);
    await db.query(`CREATE INDEX idx_logs_severity_ts ON logs(severity, ts DESC);`);
    
    try {
      await db.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
      await db.query(`CREATE INDEX idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops);`);
    } catch (e) {
      console.log("pg_trgm not available, falling back to standard index or no index for message");
    }

    const severities = ['debug', 'info', 'warn', 'error'];
    const services = ['auth-service', 'billing-service', 'api-gateway', 'user-service', 'notification-service', 'search-service', 'inventory-service', 'payment-service'];
    const templates = [
      "User {user} logged in successfully",
      "Failed to authenticate user {user}",
      "Payment of {amount} processed for account {account}",
      "Timeout connecting to database",
      "Cache miss for key {key}",
      "Invalid request payload: {payload}",
      "Service started on port {port}",
      "Disk usage at {percent}%"
    ];

    let seed = 12345;
    function random() {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    }

    const batchSize = 5000;
    let rows = [];
    const now = new Date('2024-01-01T00:00:00Z').getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

    for (let i = 0; i < 100000; i++) {
      const ts = new Date(now - random() * thirtyDaysMs).toISOString();
      
      const sevRand = random();
      let severity = 'debug';
      if (sevRand > 0.6) severity = 'info';
      if (sevRand > 0.85) severity = 'warn';
      if (sevRand > 0.95) severity = 'error';

      const service = services[Math.floor(random() * services.length)];
      
      const template = templates[Math.floor(random() * templates.length)];
      let message = template
        .replace('{user}', 'user_' + Math.floor(random() * 10000))
        .replace('{amount}', '$' + (random() * 1000).toFixed(2))
        .replace('{account}', 'acc_' + Math.floor(random() * 10000))
        .replace('{key}', 'key_' + Math.floor(random() * 100000))
        .replace('{payload}', 'payload_' + Math.floor(random() * 1000))
        .replace('{port}', Math.floor(8000 + random() * 1000))
        .replace('{percent}', Math.floor(random() * 100));

      rows.push(`('${ts}', '${severity}', '${service}', '${message.replace(/'/g, "''")}')`);

      if (rows.length === batchSize) {
        await db.query(`INSERT INTO logs (ts, severity, service, message) VALUES ${rows.join(',')}`);
        rows = [];
      }
    }
    if (rows.length > 0) {
      await db.query(`INSERT INTO logs (ts, severity, service, message) VALUES ${rows.join(',')}`);
    }
    console.log("Seeding complete.");
  } else {
    console.log("Database already seeded.");
  }
}

let dbReady = initDb().catch(console.error);

app.get('/api/logs', async (req, res) => {
  await dbReady;
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

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countQuery = `SELECT COUNT(*) FROM logs ${whereClause}`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].count, 10);

    const rowsQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${whereClause} 
      ORDER BY ts DESC 
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    const rowsRes = await db.query(rowsQuery, [...params, limit, offset]);

    res.json({ total, rows: rowsRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stats', async (req, res) => {
  await dbReady;
  try {
    const totalRes = await db.query(`SELECT COUNT(*) FROM logs`);
    const total = parseInt(totalRes.rows[0].count, 10);

    const sevRes = await db.query(`SELECT severity, COUNT(*) FROM logs GROUP BY severity`);
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
  console.log(`Backend listening on port ${PORT}`);
});
