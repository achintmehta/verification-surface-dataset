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
    
    await db.query(`CREATE INDEX idx_logs_ts ON logs (ts DESC);`);
    await db.query(`CREATE INDEX idx_logs_severity_ts ON logs (severity, ts DESC);`);
    
    try {
      await db.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
      await db.query(`CREATE INDEX idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops);`);
      console.log("Created pg_trgm index");
    } catch (e) {
      console.log("pg_trgm not available, falling back to no trgm index");
    }
    
    const severities = ['debug', 'info', 'warn', 'error'];
    const services = ['auth', 'api', 'worker', 'db', 'cache', 'frontend', 'billing', 'notification'];
    const templates = [
      "User {user} logged in",
      "Failed to connect to {service}",
      "Processed {count} records in {time}ms",
      "Invalid payload received from {ip}",
      "Cache miss for key {key}",
      "Starting job {job}",
      "Job {job} completed successfully",
      "Disk usage at {percent}%"
    ];
    
    const batchSize = 5000;
    let rows = [];
    
    let baseTime = new Date('2023-01-01T00:00:00Z').getTime();
    
    for (let i = 0; i < 100000; i++) {
      const rand = (i * 1103515245 + 12345) % 2147483648;
      const randFloat = rand / 2147483648;
      
      let severity;
      if (randFloat < 0.6) severity = 'info';
      else if (randFloat < 0.85) severity = 'debug';
      else if (randFloat < 0.95) severity = 'warn';
      else severity = 'error';
      
      const service = services[i % services.length];
      const template = templates[i % templates.length];
      const message = template
        .replace('{user}', 'user_' + (i % 1000))
        .replace('{service}', services[(i + 1) % services.length])
        .replace('{count}', i % 100)
        .replace('{time}', i % 500)
        .replace('{ip}', \`192.168.1.\${i % 255}\`)
        .replace('{key}', 'key_' + (i % 10000))
        .replace('{job}', 'job_' + (i % 500))
        .replace('{percent}', 50 + (i % 50));
        
      const ts = new Date(baseTime + i * 1000 * 25).toISOString();
      
      rows.push(\`('\${ts}', '\${severity}', '\${service}', '\${message.replace(/'/g, "''")}')\`);
      
      if (rows.length === batchSize) {
        await db.query(\`INSERT INTO logs (ts, severity, service, message) VALUES \${rows.join(',')}\`);
        rows = [];
      }
    }
    if (rows.length > 0) {
      await db.query(\`INSERT INTO logs (ts, severity, service, message) VALUES \${rows.join(',')}\`);
    }
    console.log("Seeding complete.");
  } else {
    console.log("Database already seeded.");
  }
}

initDb().catch(console.error);

app.get('/api/logs', async (req, res) => {
  try {
    let { offset = 0, limit = 50, severity, q } = req.query;
    offset = parseInt(offset);
    limit = parseInt(limit);
    
    if (isNaN(offset) || offset < 0) return res.status(400).json({ error: 'Invalid offset' });
    if (isNaN(limit) || limit < 0 || limit > 200) return res.status(400).json({ error: 'Invalid limit' });
    if (severity && !['debug', 'info', 'warn', 'error'].includes(severity)) {
      return res.status(400).json({ error: 'Invalid severity' });
    }
    
    let conditions = [];
    let params = [];
    let paramIdx = 1;
    
    if (severity) {
      conditions.push(\`severity = $\${paramIdx++}\`);
      params.push(severity);
    }
    
    if (q) {
      conditions.push(\`message ILIKE $\${paramIdx++}\`);
      params.push(\`%\${q}%\`);
    }
    
    let whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    
    const countQuery = \`SELECT COUNT(*) FROM logs \${whereClause}\`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].count);
    
    const rowsQuery = \`
      SELECT id, ts, severity, service, message 
      FROM logs 
      \${whereClause} 
      ORDER BY ts DESC 
      LIMIT $\${paramIdx++} OFFSET $\${paramIdx++}
    \`;
    const rowsParams = [...params, limit, offset];
    const rowsRes = await db.query(rowsQuery, rowsParams);
    
    res.json({ total, rows: rowsRes.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const totalRes = await db.query(\`SELECT COUNT(*) FROM logs\`);
    const sevRes = await db.query(\`SELECT severity, COUNT(*) FROM logs GROUP BY severity\`);
    
    const stats = {
      total: parseInt(totalRes.rows[0].count),
      severities: {}
    };
    
    sevRes.rows.forEach(row => {
      stats.severities[row.severity] = parseInt(row.count);
    });
    
    res.json(stats);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(\`Server listening on port \${PORT}\`);
});
