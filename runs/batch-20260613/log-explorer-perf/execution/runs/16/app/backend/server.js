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

const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SERVICES = ['auth', 'api', 'worker', 'db', 'cache', 'frontend', 'payment', 'search'];
const TEMPLATES = [
  "User {user} logged in successfully",
  "Failed to connect to {service}",
  "Query executed in {ms}ms",
  "Payment {id} processed",
  "Cache miss for key {key}",
  "Invalid payload received from {ip}",
  "Starting background job {job}",
  "Disk space running low on {volume}"
];

async function seedDatabase() {
  console.log("Checking if database needs seeding...");
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity VARCHAR(10) NOT NULL,
      service VARCHAR(50) NOT NULL,
      message TEXT NOT NULL
    );
  `);

  const res = await db.query(`SELECT COUNT(*) as count FROM logs;`);
  const count = parseInt(res.rows[0].count, 10);

  if (count >= 100000) {
    console.log("Database already seeded.");
    return;
  }

  console.log("Seeding database with 100,000 rows...");
  await db.exec("BEGIN;");
  await db.exec("TRUNCATE logs RESTART IDENTITY;");

  const BATCH_SIZE = 5000;
  const TOTAL_ROWS = 100000;
  
  let ts = new Date('2023-01-01T00:00:00Z').getTime();
  
  for (let i = 0; i < TOTAL_ROWS; i += BATCH_SIZE) {
    let values = [];
    for (let j = 0; j < BATCH_SIZE; j++) {
      const rowNum = i + j;
      const rand1 = (rowNum * 1103515245 + 12345) % 2147483648;
      const rand2 = (rand1 * 1103515245 + 12345) % 2147483648;
      const rand3 = (rand2 * 1103515245 + 12345) % 2147483648;
      
      ts += (rand1 % 50000) + 1000;
      const dateStr = new Date(ts).toISOString();
      
      const sevRand = rand2 % 100;
      let severity = 'debug';
      if (sevRand >= 60 && sevRand < 85) severity = 'info';
      else if (sevRand >= 85 && sevRand < 95) severity = 'warn';
      else if (sevRand >= 95) severity = 'error';
      
      const service = SERVICES[rand3 % SERVICES.length];
      
      const template = TEMPLATES[rowNum % TEMPLATES.length];
      const msg = template
        .replace('{user}', `user_${rand1 % 10000}`)
        .replace('{service}', SERVICES[rand2 % SERVICES.length])
        .replace('{ms}', rand3 % 5000)
        .replace('{id}', `pay_${rand1 % 9000 + 1000}`)
        .replace('{key}', `key_${rand2 % 1000}`)
        .replace('{ip}', `${rand1 % 255}.${rand2 % 255}.${rand3 % 255}.${(rand1+rand2) % 255}`)
        .replace('{job}', `job_${rand1 % 500}`)
        .replace('{volume}', `/dev/vd${String.fromCharCode(97 + (rand2 % 6))}`);
        
      values.push(`('${dateStr}', '${severity}', '${service}', '${msg.replace(/'/g, "''")}')`);
    }
    await db.exec(`INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')};`);
    console.log(`Inserted ${i + BATCH_SIZE} rows...`);
  }
  
  await db.exec("COMMIT;");
  
  console.log("Creating indexes...");
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs(severity, ts DESC);
  `);
  
  // Try to create pg_trgm index if extension is available
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops);`);
    console.log("Created pg_trgm index.");
  } catch (e) {
    console.log("pg_trgm extension not available, skipping trigram index.");
  }
  
  console.log("Database setup complete.");
}

async function init() {
  db = new PGlite(dbPath);
  await db.waitReady;
  await seedDatabase();
  
  app.listen(3001, () => {
    console.log("Backend listening on port 3001");
  });
}

app.get('/api/logs', async (req, res) => {
  try {
    let { offset = 0, limit = 50, severity, q } = req.query;
    offset = parseInt(offset, 10);
    limit = parseInt(limit, 10);
    
    if (isNaN(offset) || offset < 0) return res.status(400).json({ error: "Invalid offset" });
    if (isNaN(limit) || limit < 0 || limit > 200) return res.status(400).json({ error: "Invalid limit" });
    if (severity && !SEVERITIES.includes(severity)) return res.status(400).json({ error: "Invalid severity" });
    
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
    
    const countQuery = `SELECT COUNT(*) as total FROM logs ${whereClause}`;
    const dataQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${whereClause} 
      ORDER BY ts DESC 
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].total, 10);
    
    const dataParams = [...params, limit, offset];
    const dataRes = await db.query(dataQuery, dataParams);
    
    res.json({ total, rows: dataRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const totalRes = await db.query(`SELECT COUNT(*) as total FROM logs`);
    const sevRes = await db.query(`SELECT severity, COUNT(*) as count FROM logs GROUP BY severity`);
    
    const stats = {
      total: parseInt(totalRes.rows[0].total, 10),
      severities: {}
    };
    
    for (const row of sevRes.rows) {
      stats.severities[row.severity] = parseInt(row.count, 10);
    }
    
    res.json(stats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

init().catch(console.error);
