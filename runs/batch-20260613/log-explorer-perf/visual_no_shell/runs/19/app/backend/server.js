import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(cors());
app.use(express.json());

const DB_PATH = './pglite-data';
const db = new PGlite(DB_PATH);

const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SERVICES = ['auth', 'api', 'worker', 'db', 'cache', 'search', 'billing', 'notification'];
const TEMPLATES = [
  "User {user} logged in",
  "Failed to connect to {service}",
  "Processed {count} records in {time}ms",
  "Disk usage at {percent}%",
  "Cache miss for key {key}",
  "Payment {id} processed successfully",
  "Invalid token provided by {ip}",
  "Starting backup process",
  "Backup completed in {time}s",
  "Rate limit exceeded for {ip}"
];

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
    console.log("Initializing database and seeding 100,000 rows...");
    
    await db.exec(`
      CREATE TABLE logs (
        id SERIAL PRIMARY KEY,
        ts TIMESTAMP NOT NULL,
        severity VARCHAR(10) NOT NULL,
        service VARCHAR(50) NOT NULL,
        message TEXT NOT NULL
      );
    `);
    
    const TOTAL_ROWS = 100000;
    const BATCH_SIZE = 5000;
    
    const now = new Date('2024-01-31T23:59:59Z').getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    
    let seed = 12345;
    function pseudoRandom() {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    }
    
    function getSeverity() {
      const r = pseudoRandom();
      if (r < 0.60) return 'debug';
      if (r < 0.85) return 'info';
      if (r < 0.95) return 'warn';
      return 'error';
    }
    
    for (let i = 0; i < TOTAL_ROWS; i += BATCH_SIZE) {
      let values = [];
      for (let j = 0; j < BATCH_SIZE; j++) {
        const ts = new Date(now - pseudoRandom() * thirtyDaysMs).toISOString();
        const severity = getSeverity();
        const service = SERVICES[Math.floor(pseudoRandom() * SERVICES.length)];
        const template = TEMPLATES[Math.floor(pseudoRandom() * TEMPLATES.length)];
        
        const message = template
          .replace('{user}', `user_${Math.floor(pseudoRandom() * 1000)}`)
          .replace('{service}', SERVICES[Math.floor(pseudoRandom() * SERVICES.length)])
          .replace('{count}', Math.floor(pseudoRandom() * 10000))
          .replace('{time}', Math.floor(pseudoRandom() * 5000))
          .replace('{percent}', Math.floor(pseudoRandom() * 50) + 50)
          .replace('{key}', `key_${Math.floor(pseudoRandom() * 100000)}`)
          .replace('{id}', `pay_${Math.floor(pseudoRandom() * 9000) + 1000}`)
          .replace('{ip}', `${Math.floor(pseudoRandom() * 255)}.${Math.floor(pseudoRandom() * 255)}.${Math.floor(pseudoRandom() * 255)}.${Math.floor(pseudoRandom() * 255)}`);
          
        values.push(`('${ts}', '${severity}', '${service}', '${message.replace(/'/g, "''")}')`);
      }
      
      await db.exec(`
        INSERT INTO logs (ts, severity, service, message)
        VALUES ${values.join(', ')};
      `);
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

initDb().catch(console.error);

app.get('/api/logs', async (req, res) => {
  try {
    let { offset = 0, limit = 50, severity, q } = req.query;
    
    offset = parseInt(offset, 10);
    limit = parseInt(limit, 10);
    
    if (isNaN(offset) || offset < 0) {
      return res.status(400).json({ error: 'Invalid offset' });
    }
    if (isNaN(limit) || limit < 1 || limit > 200) {
      return res.status(400).json({ error: 'Invalid limit (must be 1-200)' });
    }
    if (severity && !SEVERITIES.includes(severity)) {
      return res.status(400).json({ error: 'Invalid severity' });
    }
    
    let conditions = [];
    let params = [];
    let paramIndex = 1;
    
    if (severity) {
      conditions.push(`severity = $${paramIndex++}`);
      params.push(severity);
    }
    
    if (q) {
      conditions.push(`message ILIKE $${paramIndex++}`);
      params.push(`%${q}%`);
    }
    
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    
    const countQuery = `SELECT COUNT(*) as total FROM logs ${whereClause}`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].total, 10);
    
    const rowsQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${whereClause} 
      ORDER BY ts DESC 
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
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

app.get('/api/stats', async (req, res) => {
  try {
    const totalRes = await db.query('SELECT COUNT(*) as total FROM logs');
    const severityRes = await db.query('SELECT severity, COUNT(*) as count FROM logs GROUP BY severity');
    
    const counts = {
      total: parseInt(totalRes.rows[0].total, 10),
      debug: 0,
      info: 0,
      warn: 0,
      error: 0
    };
    
    for (const row of severityRes.rows) {
      counts[row.severity] = parseInt(row.count, 10);
    }
    
    res.json(counts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
