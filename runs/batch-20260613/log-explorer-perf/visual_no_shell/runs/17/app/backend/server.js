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
    console.log("Initializing database and seeding 100,000 rows...");
    
    try {
      await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
      console.log("pg_trgm extension created.");
    } catch (e) {
      console.log("pg_trgm extension not available, proceeding without it.");
    }

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
    const services = ['auth-service', 'payment-gateway', 'user-profile', 'search-engine', 'recommendation', 'notification', 'billing', 'inventory'];
    const templates = [
      "User {user} logged in successfully",
      "Failed to process payment for {user}",
      "Cache miss for key {key}",
      "Database connection timeout",
      "Retrying request to {service}",
      "Invalid payload received from {service}",
      "Successfully updated profile for {user}",
      "Disk space running low on {node}"
    ];
    
    const now = new Date().getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    
    let seed = 12345;
    function random() {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    }
    
    const batchSize = 5000;
    for (let i = 0; i < 100000; i += batchSize) {
      let values = [];
      for (let j = 0; j < batchSize; j++) {
        const r = random();
        let sev = 'debug';
        if (r > 0.6) sev = 'info';
        if (r > 0.85) sev = 'warn';
        if (r > 0.95) sev = 'error';
        
        const ts = new Date(now - random() * thirtyDaysMs).toISOString();
        const service = services[Math.floor(random() * services.length)];
        
        let msg = templates[Math.floor(random() * templates.length)];
        msg = msg.replace('{user}', 'user_' + Math.floor(random() * 10000));
        msg = msg.replace('{key}', 'key_' + Math.floor(random() * 1000));
        msg = msg.replace('{service}', services[Math.floor(random() * services.length)]);
        msg = msg.replace('{node}', 'node_' + Math.floor(random() * 100));
        
        msg = msg.replace(/'/g, "''");
        
        values.push(`('${ts}', '${sev}', '${service}', '${msg}')`);
      }
      await db.exec(`INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')};`);
      console.log(`Seeded ${i + batchSize} rows`);
    }
    
    console.log("Creating indexes...");
    await db.exec(`
      CREATE INDEX idx_logs_ts ON logs (ts DESC);
      CREATE INDEX idx_logs_severity_ts ON logs (severity, ts DESC);
    `);
    
    try {
      await db.exec(`CREATE INDEX idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops);`);
      console.log("Trigram index created.");
    } catch (e) {
      console.log("Could not create trigram index.");
    }
    
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
    
    if (isNaN(offset) || offset < 0) return res.status(400).json({ error: 'Invalid offset' });
    if (isNaN(limit) || limit < 0 || limit > 200) return res.status(400).json({ error: 'Invalid limit' });
    
    let conditions = [];
    let params = [];
    let paramIdx = 1;
    
    if (severity) {
      const validSeverities = ['debug', 'info', 'warn', 'error'];
      if (!validSeverities.includes(severity)) {
        return res.status(400).json({ error: 'Invalid severity' });
      }
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
    
    const sevRes = await db.query('SELECT severity, COUNT(*) FROM logs GROUP BY severity');
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
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}).catch(err => {
  console.error("Failed to initialize DB", err);
  process.exit(1);
});