const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

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
    console.log('Initializing database schema...');
    await db.query(`
      CREATE TABLE logs (
        id SERIAL PRIMARY KEY,
        ts TIMESTAMP NOT NULL,
        severity VARCHAR(10) NOT NULL,
        service VARCHAR(50) NOT NULL,
        message TEXT NOT NULL,
        message_lower TEXT NOT NULL
      );
    `);
    
    console.log('Seeding 100,000 rows...');
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
    const now = new Date('2023-10-01T00:00:00Z').getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    
    for (let i = 0; i < totalRows; i += batchSize) {
      let values = [];
      for (let j = 0; j < batchSize; j++) {
        const r = random();
        let severity = 'debug';
        if (r > 0.6) severity = 'info';
        if (r > 0.85) severity = 'warn';
        if (r > 0.95) severity = 'error';
        
        const service = getRandomItem(services);
        const ts = new Date(now - random() * thirtyDaysMs).toISOString();
        
        let message = getRandomItem(templates);
        message = message.replace('{user}', getRandomItem(users));
        message = message.replace('{amount}', '$' + (random() * 100).toFixed(2));
        message = message.replace('{order}', 'ORD-' + Math.floor(random() * 10000));
        message = message.replace('{location}', getRandomItem(locations));
        message = message.replace('{item}', getRandomItem(items));
        message = message.replace('{key}', 'key-' + Math.floor(random() * 1000));
        message = message.replace('{payload}', 'payload-' + Math.floor(random() * 1000));
        message = message.replace('{service}', getRandomItem(services));
        
        message = message.replace(/'/g, "''");
        const message_lower = message.toLowerCase();
        
        values.push(`('${ts}', '${severity}', '${service}', '${message}', '${message_lower}')`);
      }
      
      await db.query(`
        INSERT INTO logs (ts, severity, service, message, message_lower)
        VALUES ${values.join(', ')}
      `);
      console.log(`Inserted ${i + batchSize} rows`);
    }
    
    console.log('Creating indexes...');
    await db.query(`CREATE INDEX idx_logs_ts_id ON logs (ts DESC, id DESC);`);
    await db.query(`CREATE INDEX idx_logs_severity_ts_id ON logs (severity, ts DESC, id DESC);`);
    
    await db.query(`VACUUM ANALYZE logs;`);
    
    console.log('Database initialization complete.');
  } else {
    console.log('Database already initialized.');
  }
}

initDb().catch(console.error);

app.get('/api/stats', async (req, res) => {
  try {
    const totalRes = await db.query(`SELECT COUNT(*) as count FROM logs`);
    const severityRes = await db.query(`SELECT severity, COUNT(*) as count FROM logs GROUP BY severity`);
    
    const stats = {
      total: parseInt(totalRes.rows[0].count, 10),
      severities: {}
    };
    
    severityRes.rows.forEach(row => {
      stats.severities[row.severity] = parseInt(row.count, 10);
    });
    
    res.json(stats);
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
      return res.status(400).json({ error: 'Invalid limit (max 200)' });
    }
    
    const validSeverities = ['debug', 'info', 'warn', 'error'];
    if (severity && !validSeverities.includes(severity)) {
      return res.status(400).json({ error: 'Invalid severity' });
    }
    
    let whereClauses = [];
    let params = [];
    let paramIndex = 1;
    
    if (severity) {
      whereClauses.push(`severity = $${paramIndex++}`);
      params.push(severity);
    }
    
    if (q) {
      whereClauses.push(`message_lower LIKE $${paramIndex++}`);
      params.push(`%${q.toLowerCase()}%`);
    }
    
    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    
    const countQuery = `SELECT COUNT(*) as count FROM logs ${whereStr}`;
    
    const rowsQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      WHERE id IN (
        SELECT id FROM logs 
        ${whereStr} 
        ORDER BY ts DESC, id DESC 
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      )
      ORDER BY ts DESC, id DESC
    `;
    const rowsParams = [...params, limit, offset];
    
    // Run concurrently
    const [countRes, rowsRes] = await Promise.all([
      db.query(countQuery, params),
      db.query(rowsQuery, rowsParams)
    ]);
    
    const total = parseInt(countRes.rows[0].count, 10);
    
    res.json({
      total,
      rows: rowsRes.rows
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
