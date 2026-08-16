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

  const res = await db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = 'logs'
    );
  `);

  const exists = res.rows[0].exists;

  if (!exists) {
    console.log("Initializing database schema...");
    
    try {
      await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    } catch (e) {
      console.warn("Could not create pg_trgm extension", e);
    }

    await db.exec(`
      CREATE TABLE logs (
        id SERIAL PRIMARY KEY,
        ts TIMESTAMP NOT NULL,
        severity VARCHAR(10) NOT NULL,
        service VARCHAR(50) NOT NULL,
        message TEXT NOT NULL
      );

      CREATE INDEX idx_logs_ts ON logs (ts DESC);
      CREATE INDEX idx_logs_severity_ts ON logs (severity, ts DESC);
    `);

    try {
      await db.exec(`CREATE INDEX idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops);`);
    } catch (e) {
      console.warn("Could not create trgm index", e);
    }

    console.log("Seeding 100,000 rows...");
    const severities = ['debug', 'info', 'warn', 'error'];
    const services = ['auth-service', 'payment-gateway', 'user-profile', 'search-engine', 'notification-service', 'billing-service', 'inventory-service', 'analytics-engine'];
    const templates = [
      "User {user} logged in successfully",
      "Failed to authenticate user {user}",
      "Payment of {amount} processed for account {account}",
      "Insufficient funds for account {account}",
      "Profile updated for user {user}",
      "Search query '{query}' returned {count} results",
      "Notification sent to {user}",
      "Failed to send notification to {user}",
      "Invoice {invoice} generated for account {account}",
      "Inventory item {item} is low on stock",
      "Analytics event {event} recorded",
      "Database connection timeout",
      "Cache miss for key {key}",
      "Rate limit exceeded for IP {ip}",
      "Unhandled exception in {module}"
    ];

    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    
    let seed = 123456789;
    function random() {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    }

    function getRandomInt(min, max) {
      return Math.floor(random() * (max - min)) + min;
    }

    function getRandomElement(arr) {
      return arr[getRandomInt(0, arr.length)];
    }

    const batchSize = 5000;
    for (let i = 0; i < 100000; i += batchSize) {
      let values = [];
      for (let j = 0; j < batchSize; j++) {
        const ts = new Date(now - getRandomInt(0, thirtyDaysMs)).toISOString();
        
        const sevRand = random();
        let severity = 'debug';
        if (sevRand > 0.95) severity = 'error';
        else if (sevRand > 0.85) severity = 'warn';
        else if (sevRand > 0.60) severity = 'info';

        const service = getRandomElement(services);
        
        let message = getRandomElement(templates);
        message = message.replace('{user}', 'user_' + getRandomInt(1, 10000));
        message = message.replace('{amount}', '$' + getRandomInt(10, 1000));
        message = message.replace('{account}', 'acc_' + getRandomInt(1, 5000));
        message = message.replace('{query}', 'query_' + getRandomInt(1, 100));
        message = message.replace('{count}', getRandomInt(0, 1000));
        message = message.replace('{invoice}', 'inv_' + getRandomInt(1, 10000));
        message = message.replace('{item}', 'item_' + getRandomInt(1, 1000));
        message = message.replace('{event}', 'evt_' + getRandomInt(1, 500));
        message = message.replace('{key}', 'key_' + getRandomInt(1, 10000));
        message = message.replace('{ip}', getRandomInt(1, 255) + '.' + getRandomInt(1, 255) + '.0.1');
        message = message.replace('{module}', 'mod_' + getRandomInt(1, 50));

        message = message.replace(/'/g, "''");

        values.push(`('${ts}', '${severity}', '${service}', '${message}')`);
      }
      
      await db.exec(`
        INSERT INTO logs (ts, severity, service, message)
        VALUES ${values.join(', ')}
      `);
    }
    console.log("Seeding complete.");
  } else {
    console.log("Database already initialized.");
  }
}

app.get('/api/stats', async (req, res) => {
  try {
    const totalRes = await db.query(`SELECT COUNT(*) as total FROM logs`);
    const sevRes = await db.query(`SELECT severity, COUNT(*) as count FROM logs GROUP BY severity`);
    
    const stats = {
      total: parseInt(totalRes.rows[0].total, 10),
      severities: {}
    };
    
    sevRes.rows.forEach(row => {
      stats.severities[row.severity] = parseInt(row.count, 10);
    });
    
    res.json(stats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

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

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countQuery = \`SELECT COUNT(*) as total FROM logs \${whereClause}\`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].total, 10);

    const rowsQuery = \`
      SELECT id, ts, severity, service, message 
      FROM logs 
      \${whereClause} 
      ORDER BY ts DESC 
      LIMIT $\${paramIdx++} OFFSET $\${paramIdx++}
    \`;
    const rowsParams = [...params, limit, offset];
    
    const rowsRes = await db.query(rowsQuery, rowsParams);
    
    res.json({
      total,
      rows: rowsRes.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3001;

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(\`Backend listening on port \${PORT}\`);
  });
}).catch(err => {
  console.error("Failed to initialize database", err);
  process.exit(1);
});
