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

const SEED_COUNT = 100000;

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

  if (count === 0) {
    console.log('Seeding database...');
    const services = ['auth', 'api', 'billing', 'worker', 'db', 'cache', 'search', 'frontend'];
    const severities = ['debug', 'info', 'warn', 'error'];
    // 60/25/10/5 distribution
    const getSeverity = (i) => {
      const r = i % 100;
      if (r < 60) return 'debug';
      if (r < 85) return 'info';
      if (r < 95) return 'warn';
      return 'error';
    };

    const templates = [
      "User {user} logged in successfully",
      "Failed to connect to {service}",
      "Payment processed for {amount}",
      "Cache miss for key {key}",
      "Query executed in {time}ms",
      "Disk space running low on {node}",
      "Invalid token received from {ip}",
      "Starting background job {job}"
    ];

    const batchSize = 5000;
    let values = [];
    
    // Deterministic seed
    let ts = new Date('2023-01-01T00:00:00Z').getTime();
    
    for (let i = 0; i < SEED_COUNT; i++) {
      const severity = getSeverity(i);
      const service = services[i % services.length];
      const template = templates[i % templates.length];
      
      let message = template;
      if (message.includes('{user}')) message = message.replace('{user}', `user_${i % 1000}`);
      if (message.includes('{service}')) message = message.replace('{service}', services[(i+1) % services.length]);
      if (message.includes('{amount}')) message = message.replace('{amount}', `$${(i % 100) + 10}`);
      if (message.includes('{key}')) message = message.replace('{key}', `key_${i % 5000}`);
      if (message.includes('{time}')) message = message.replace('{time}', `${i % 500}`);
      if (message.includes('{node}')) message = message.replace('{node}', `node_${i % 10}`);
      if (message.includes('{ip}')) message = message.replace('{ip}', `192.168.1.${i % 255}`);
      if (message.includes('{job}')) message = message.replace('{job}', `job_${i % 100}`);

      ts += 25920; // 25.92 seconds
      const dateStr = new Date(ts).toISOString();

      values.push(`('${dateStr}', '${severity}', '${service}', '${message.replace(/'/g, "''")}')`);

      if (values.length === batchSize) {
        await db.exec(`INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')}`);
        values = [];
      }
    }
    if (values.length > 0) {
      await db.exec(`INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')}`);
    }
    
    console.log('Creating indexes...');
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);
      CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);
    `);
    try {
      await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops);`);
    } catch (e) {
      console.log('pg_trgm not available, falling back to standard index or no index for message');
    }
    console.log('Seeding complete.');
  } else {
    console.log(`Database already seeded with ${count} rows.`);
  }
}

app.get('/api/stats', async (req, res) => {
  try {
    const totalRes = await db.query('SELECT COUNT(*) as count FROM logs');
    const sevRes = await db.query('SELECT severity, COUNT(*) as count FROM logs GROUP BY severity');
    
    const stats = {
      total: parseInt(totalRes.rows[0].count, 10),
      severities: {}
    };
    sevRes.rows.forEach(row => {
      stats.severities[row.severity] = parseInt(row.count, 10);
    });
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

    const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

    const countQuery = `SELECT COUNT(*) as count FROM logs ${whereStr}`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].count, 10);

    const dataQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${whereStr} 
      ORDER BY ts DESC 
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    const dataParams = [...params, limit, offset];
    const dataRes = await db.query(dataQuery, dataParams);

    res.json({
      total,
      rows: dataRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database', err);
  process.exit(1);
});
