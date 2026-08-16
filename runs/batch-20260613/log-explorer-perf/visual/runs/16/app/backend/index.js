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
  
  // Create table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity VARCHAR(10) NOT NULL,
      service VARCHAR(50) NOT NULL,
      message TEXT NOT NULL
    );
  `);

  // Check if seeded
  const res = await db.query(`SELECT COUNT(*) as count FROM logs;`);
  const count = parseInt(res.rows[0].count, 10);

  if (count === 0) {
    console.log('Seeding database with 100,000 rows...');
    const severities = ['debug', 'info', 'warn', 'error'];
    const services = ['auth-service', 'user-service', 'payment-service', 'email-service', 'inventory-service', 'order-service', 'shipping-service', 'notification-service'];
    
    const templates = [
      "User {user} logged in successfully",
      "Failed to authenticate user {user}",
      "Payment of {amount} processed for order {order}",
      "Order {order} shipped to {location}",
      "Inventory low for item {item}",
      "Email sent to {user}",
      "Database connection timeout",
      "Cache miss for key {key}",
      "Invalid request payload: {payload}",
      "Service {service} restarted"
    ];

    const users = ['alice', 'bob', 'charlie', 'dave', 'eve'];
    const locations = ['NY', 'CA', 'TX', 'FL', 'WA'];
    const items = ['widget-a', 'widget-b', 'gadget-x', 'gadget-y'];

    // Deterministic random
    let seed = 123456789;
    function random() {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    }

    function getRandomItem(arr) {
      return arr[Math.floor(random() * arr.length)];
    }

    function getSeverity() {
      const r = random();
      if (r < 0.60) return 'debug';
      if (r < 0.85) return 'info';
      if (r < 0.95) return 'warn';
      return 'error';
    }

    const batchSize = 5000;
    const totalRows = 100000;
    const now = new Date('2023-10-01T00:00:00Z').getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

    for (let i = 0; i < totalRows; i += batchSize) {
      let values = [];
      for (let j = 0; j < batchSize; j++) {
        const rowIdx = i + j;
        const ts = new Date(now - (totalRows - rowIdx) * (thirtyDaysMs / totalRows)).toISOString();
        const severity = getSeverity();
        const service = getRandomItem(services);
        
        let message = getRandomItem(templates);
        message = message.replace('{user}', getRandomItem(users));
        message = message.replace('{amount}', '$' + Math.floor(random() * 1000));
        message = message.replace('{order}', 'ORD-' + Math.floor(random() * 10000));
        message = message.replace('{location}', getRandomItem(locations));
        message = message.replace('{item}', getRandomItem(items));
        message = message.replace('{key}', 'key-' + Math.floor(random() * 100));
        message = message.replace('{payload}', 'payload-' + Math.floor(random() * 100));
        message = message.replace('{service}', getRandomItem(services));

        // Escape single quotes
        message = message.replace(/'/g, "''");

        values.push(`('${ts}', '${severity}', '${service}', '${message}')`);
      }
      
      await db.exec(`
        INSERT INTO logs (ts, severity, service, message)
        VALUES ${values.join(', ')};
      `);
      console.log(`Seeded ${i + batchSize} rows...`);
    }

    console.log('Creating indexes...');
    // Create indexes
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);
      CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);
    `);
    
    try {
      await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops);`);
      console.log('Created pg_trgm index.');
    } catch (e) {
      console.log('pg_trgm not available, skipping trigram index.', e.message);
    }
    
    console.log('Seeding complete.');
  } else {
    console.log(`Database already seeded with ${count} rows.`);
  }
}

initDB().catch(console.error);

app.get('/api/stats', async (req, res) => {
  try {
    const totalRes = await db.query(`SELECT COUNT(*) as count FROM logs;`);
    const total = parseInt(totalRes.rows[0].count, 10);

    const severityRes = await db.query(`
      SELECT severity, COUNT(*) as count 
      FROM logs 
      GROUP BY severity;
    `);
    
    const counts = {
      debug: 0,
      info: 0,
      warn: 0,
      error: 0
    };
    
    severityRes.rows.forEach(row => {
      counts[row.severity] = parseInt(row.count, 10);
    });

    res.json({ total, counts });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    if (isNaN(limit) || limit < 0 || limit > 200) {
      return res.status(400).json({ error: 'Invalid limit' });
    }
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

    // Get total count for this filter
    const countQuery = `SELECT COUNT(*) as count FROM logs ${whereStr}`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].count, 10);

    // Get rows
    const rowsQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${whereStr} 
      ORDER BY ts DESC 
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    const rowsParams = [...params, limit, offset];
    
    const rowsRes = await db.query(rowsQuery, rowsParams);

    res.json({ total, rows: rowsRes.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/indexes', async (req, res) => {
  const r = await db.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'logs';`);
  res.json(r.rows);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});
