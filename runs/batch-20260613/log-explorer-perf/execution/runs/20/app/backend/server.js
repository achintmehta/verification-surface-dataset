const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

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
    console.log("Initializing database schema and seeding data...");
    await db.exec(`
      CREATE TABLE logs (
        id SERIAL PRIMARY KEY,
        ts TIMESTAMP NOT NULL,
        severity VARCHAR(10) NOT NULL,
        service VARCHAR(50) NOT NULL,
        message TEXT NOT NULL
      );
    `);

    // Seed 100,000 rows
    const totalRows = 100000;
    const batchSize = 5000;
    const services = ['auth-service', 'user-service', 'payment-service', 'email-service', 'inventory-service', 'order-service', 'shipping-service', 'notification-service'];
    const severities = ['debug', 'info', 'warn', 'error'];
    
    // 60/25/10/5 distribution
    function getSeverity(rand) {
      if (rand < 0.60) return 'debug';
      if (rand < 0.85) return 'info';
      if (rand < 0.95) return 'warn';
      return 'error';
    }

    const templates = [
      "User {user} logged in successfully",
      "Failed to authenticate user {user}",
      "Payment {id} processed for amount {amount}",
      "Order {id} created by user {user}",
      "Inventory low for item {item}",
      "Email sent to {email}",
      "Shipping updated for order {id}",
      "Notification {id} delivered"
    ];

    // Deterministic random function
    let seed = 1;
    function random() {
      const x = Math.sin(seed++) * 10000;
      return x - Math.floor(x);
    }

    const now = new Date('2023-10-01T00:00:00Z').getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

    for (let i = 0; i < totalRows; i += batchSize) {
      let values = [];
      for (let j = 0; j < batchSize; j++) {
        const rowIdx = i + j;
        const ts = new Date(now - random() * thirtyDaysMs).toISOString();
        const severity = getSeverity(random());
        const service = services[Math.floor(random() * services.length)];
        
        const template = templates[Math.floor(random() * templates.length)];
        const message = template
          .replace('{user}', 'user_' + Math.floor(random() * 10000))
          .replace('{id}', 'id_' + Math.floor(random() * 100000))
          .replace('{amount}', '$' + (random() * 1000).toFixed(2))
          .replace('{item}', 'item_' + Math.floor(random() * 5000))
          .replace('{email}', 'user_' + Math.floor(random() * 10000) + '@example.com');

        values.push(`('${ts}', '${severity}', '${service}', '${message.replace(/'/g, "''")}')`);
      }
      
      await db.exec(`
        INSERT INTO logs (ts, severity, service, message)
        VALUES ${values.join(', ')};
      `);
      console.log(`Seeded ${i + batchSize} rows...`);
    }

    console.log("Creating indexes...");
    await db.exec(`
      CREATE INDEX idx_logs_ts ON logs (ts DESC);
      CREATE INDEX idx_logs_severity_ts ON logs (severity, ts DESC);
    `);
    console.log("Database initialization complete.");
  } else {
    console.log("Database already initialized.");
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
      return res.status(400).json({ error: 'Invalid limit (max 200)' });
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

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

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
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
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
    const totalRes = await db.query(`SELECT COUNT(*) FROM logs`);
    const total = parseInt(totalRes.rows[0].count, 10);

    const severityRes = await db.query(`
      SELECT severity, COUNT(*) 
      FROM logs 
      GROUP BY severity
    `);
    
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

const PORT = process.env.PORT || 3001;

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Backend listening on port ${PORT}`);
  });
}).catch(err => {
  console.error("Failed to initialize database:", err);
  process.exit(1);
});
