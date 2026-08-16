const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const { pg_trgm } = require('@electric-sql/pglite/contrib/pg_trgm');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const dbPath = path.join(__dirname, '../pglite-data');
let db;

async function initDB() {
  db = new PGlite(dbPath, {
    extensions: { pg_trgm }
  });
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
    
    const severities = ['debug', 'info', 'warn', 'error'];
    const services = ['auth-service', 'user-service', 'payment-service', 'email-service', 'inventory-service', 'order-service', 'shipping-service', 'notification-service'];
    const templates = [
      "User {user} logged in successfully",
      "Failed to authenticate user {user}",
      "Payment of {amount} processed for order {order}",
      "Order {order} created by user {user}",
      "Inventory low for item {item}",
      "Email sent to {email}",
      "Shipping updated for order {order}",
      "Notification sent to user {user}"
    ];
    
    const users = ['alice', 'bob', 'charlie', 'dave', 'eve', 'frank', 'grace', 'heidi'];
    const items = ['widget', 'gadget', 'doohickey', 'thingamajig'];
    const emails = ['test@example.com', 'admin@example.com', 'user@example.com'];
    
    const batchSize = 5000;
    const totalRows = 100000;
    
    let baseTime = new Date();
    baseTime.setDate(baseTime.getDate() - 30);
    
    for (let i = 0; i < totalRows; i += batchSize) {
      let values = [];
      for (let j = 0; j < batchSize; j++) {
        const rowIdx = i + j;
        
        const rand = (seed) => {
          let x = Math.sin(seed + 1) * 10000;
          return x - Math.floor(x);
        };
        
        const r1 = rand(rowIdx);
        let severity = 'debug';
        if (r1 > 0.6) severity = 'info';
        if (r1 > 0.85) severity = 'warn';
        if (r1 > 0.95) severity = 'error';
        
        const service = services[Math.floor(rand(rowIdx + 1) * services.length)];
        
        const template = templates[Math.floor(rand(rowIdx + 2) * templates.length)];
        let message = template
          .replace('{user}', users[Math.floor(rand(rowIdx + 3) * users.length)])
          .replace('{amount}', '$' + (Math.floor(rand(rowIdx + 4) * 1000) / 100).toFixed(2))
          .replace('{order}', 'ORD-' + Math.floor(rand(rowIdx + 5) * 10000))
          .replace('{item}', items[Math.floor(rand(rowIdx + 6) * items.length)])
          .replace('{email}', emails[Math.floor(rand(rowIdx + 7) * emails.length)]);
          
        const hex = Math.floor(rand(rowIdx + 8) * 0xffffff).toString(16).padStart(6, '0');
        message += ` [ref:${hex}]`;
        
        const ts = new Date(baseTime.getTime() + rowIdx * (30 * 24 * 60 * 60 * 1000) / totalRows);
        
        values.push(`('${ts.toISOString()}', '${severity}', '${service}', '${message.replace(/'/g, "''")}')`);
      }
      
      await db.exec(`
        INSERT INTO logs (ts, severity, service, message)
        VALUES ${values.join(', ')};
      `);
    }
    
    console.log('Creating indexes...');
    await db.exec(`
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
      CREATE INDEX idx_logs_ts ON logs (ts DESC);
      CREATE INDEX idx_logs_severity_ts ON logs (severity, ts DESC);
      CREATE INDEX idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops);
      ANALYZE logs;
    `);
    console.log('Database initialization complete.');
  } else {
    console.log('Database already initialized.');
  }
}

initDB().catch(console.error);

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
    
    const countQuery = `SELECT COUNT(*) FROM logs ${whereClause}`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].count, 10);
    
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
