import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, 'pglite-data');

const app = express();
app.use(cors());
app.use(express.json());

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
    console.log("Initializing schema and seeding data...");
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
      console.log("pg_trgm not available, skipping trgm index");
    }
    
    const services = [
      'auth-service', 'payment-gateway', 'user-profile', 'search-engine', 
      'notification-worker', 'billing-job', 'api-router', 'cache-node'
    ];
    
    const templates = [
      "User {user} logged in successfully",
      "Failed to connect to {db}",
      "Payment {id} processed",
      "Cache miss for key {key}",
      "Rate limit exceeded for IP {ip}",
      "Starting job {job}",
      "Job {job} completed in {ms}ms",
      "Unhandled exception in {module}: {error}"
    ];
    
    let seed = 12345;
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
    
    const now = new Date('2023-01-31T00:00:00Z').getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    
    const batchSize = 5000;
    let rows = [];
    
    for (let i = 0; i < 100000; i++) {
      const ts = new Date(now - random() * thirtyDaysMs).toISOString();
      const severity = getSeverity();
      const service = getRandomItem(services);
      
      let message = getRandomItem(templates);
      message = message.replace('{user}', 'user_' + Math.floor(random() * 10000));
      message = message.replace('{db}', 'db_' + Math.floor(random() * 5));
      message = message.replace('{id}', 'txn_' + Math.floor(random() * 100000));
      message = message.replace('{key}', 'key_' + Math.floor(random() * 50000));
      message = message.replace('{ip}', Math.floor(random()*255) + '.' + Math.floor(random()*255) + '.0.1');
      message = message.replace('{job}', 'job_' + Math.floor(random() * 100));
      message = message.replace('{ms}', Math.floor(random() * 5000));
      message = message.replace('{module}', 'mod_' + Math.floor(random() * 20));
      message = message.replace('{error}', 'err_' + Math.floor(random() * 500));
      
      // Escape single quotes in message
      message = message.replace(/'/g, "''");
      
      rows.push(`('${ts}', '${severity}', '${service}', '${message}')`);
      
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
    console.log("Database already initialized.");
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
    if (isNaN(limit) || limit < 1 || limit > 200) {
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
    
    const countQuery = \`SELECT COUNT(*) FROM logs \${whereStr}\`;
    const dataQuery = \`
      SELECT id, ts, severity, service, message 
      FROM logs 
      \${whereStr} 
      ORDER BY ts DESC 
      LIMIT $\${paramIdx++} OFFSET $\${paramIdx++}
    \`;
    
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].count, 10);
    
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
    const totalRes = await db.query(\`SELECT COUNT(*) FROM logs\`);
    const total = parseInt(totalRes.rows[0].count, 10);
    
    const sevRes = await db.query(\`SELECT severity, COUNT(*) FROM logs GROUP BY severity\`);
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
  console.log(\`Backend listening on port \${PORT}\`);
});
