const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const dbPath = path.join(__dirname, 'pglite-data');
let db;

async function initDB() {
  db = new PGlite(dbPath);
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
    console.log('Initializing database and seeding 100,000 rows...');
    await db.exec(`
      CREATE TABLE logs (
        id SERIAL PRIMARY KEY,
        ts TIMESTAMP NOT NULL,
        severity VARCHAR(10) NOT NULL,
        service VARCHAR(50) NOT NULL,
        message TEXT NOT NULL
      );
    `);

    await db.exec(`
      CREATE INDEX idx_logs_ts ON logs(ts DESC);
      CREATE INDEX idx_logs_severity_ts ON logs(severity, ts DESC);
    `);
    
    try {
      await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
      await db.exec(`CREATE INDEX idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops);`);
    } catch (e) {
      console.log('pg_trgm not available, skipping trgm index', e.message);
    }

    const severities = ['debug', 'info', 'warn', 'error'];
    const services = ['auth-service', 'payment-gateway', 'user-profile', 'search-engine', 'recommendation', 'notification', 'billing', 'inventory'];
    const templates = [
      "User {user} logged in successfully",
      "Failed to authenticate user {user}",
      "Payment of {amount} processed for account {account}",
      "Database connection timeout in {module}",
      "Cache miss for key {key}",
      "Sending email to {email}",
      "Disk space running low on {node}",
      "Invalid request payload from {ip}"
    ];

    let seed = 12345;
    function random() {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    }

    function getRandomItem(arr) {
      return arr[Math.floor(random() * arr.length)];
    }

    const batchSize = 5000;
    const totalRows = 100000;
    const now = new Date('2023-01-01T00:00:00Z').getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

    for (let i = 0; i < totalRows; i += batchSize) {
      let values = [];
      for (let j = 0; j < batchSize; j++) {
        const ts = new Date(now - random() * thirtyDaysMs).toISOString();
        
        const sevRand = random();
        let severity = 'debug';
        if (sevRand > 0.6) severity = 'info';
        if (sevRand > 0.85) severity = 'warn';
        if (sevRand > 0.95) severity = 'error';

        const service = getRandomItem(services);
        
        let message = getRandomItem(templates);
        message = message.replace('{user}', 'user_' + Math.floor(random() * 10000));
        message = message.replace('{amount}', '$' + (random() * 1000).toFixed(2));
        message = message.replace('{account}', 'acc_' + Math.floor(random() * 10000));
        message = message.replace('{module}', 'mod_' + Math.floor(random() * 100));
        message = message.replace('{key}', 'key_' + Math.floor(random() * 100000));
        message = message.replace('{email}', 'user' + Math.floor(random() * 1000) + '@example.com');
        message = message.replace('{node}', 'node_' + Math.floor(random() * 50));
        message = message.replace('{ip}', Math.floor(random()*255) + '.' + Math.floor(random()*255) + '.0.1');

        message = message.replace(/'/g, "''");

        values.push(`('${ts}', '${severity}', '${service}', '${message}')`);
      }
      
      await db.exec(`
        INSERT INTO logs (ts, severity, service, message)
        VALUES ${values.join(',')}
      `);
      console.log(`Seeded ${i + batchSize} rows...`);
    }
    console.log('Seeding complete.');
  } else {
    console.log('Database already initialized.');
  }
}

app.get('/api/stats', async (req, res) => {
  try {
    const totalRes = await db.query(`SELECT COUNT(*) as count FROM logs`);
    const sevRes = await db.query(`SELECT severity, COUNT(*) as count FROM logs GROUP BY severity`);
    
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
    
    const validSeverities = ['debug', 'info', 'warn', 'error'];
    if (severity && !validSeverities.includes(severity)) {
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

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countQuery = `SELECT COUNT(*) as count FROM logs ${whereClause}`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].count, 10);

    const dataQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      WHERE id IN (
        SELECT id FROM logs 
        ${whereClause} 
        ORDER BY ts DESC 
        LIMIT $${paramIdx++} OFFSET $${paramIdx++}
      )
      ORDER BY ts DESC
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

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Backend listening on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize DB', err);
  process.exit(1);
});
