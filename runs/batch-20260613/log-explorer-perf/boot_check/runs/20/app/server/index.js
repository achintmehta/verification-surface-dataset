import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'pglite-data');

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
    console.log("Initializing database schema...");
    await db.exec(`
      CREATE TABLE logs (
        id SERIAL PRIMARY KEY,
        ts TIMESTAMP NOT NULL,
        severity VARCHAR(10) NOT NULL,
        service VARCHAR(50) NOT NULL,
        message TEXT NOT NULL
      );
    `);

    console.log("Seeding 100,000 rows...");
    const severities = ['debug', 'info', 'warn', 'error'];
    const services = ['auth', 'api', 'worker', 'db', 'cache', 'frontend', 'billing', 'search'];
    const templates = [
      "User {user} logged in",
      "Failed to connect to {service}",
      "Query took {ms}ms",
      "Disk usage at {pct}%",
      "Cache miss for key {key}",
      "Payment processed for {amount}",
      "Invalid token {token}",
      "Starting job {job}"
    ];

    let seed = 1;
    function random() {
      const x = Math.sin(seed++) * 10000;
      return x - Math.floor(x);
    }

    function randomChoice(arr) {
      return arr[Math.floor(random() * arr.length)];
    }

    const batchSize = 5000;
    const totalRows = 100000;
    const startDate = new Date('2023-01-01T00:00:00Z').getTime();
    const endDate = new Date('2023-01-31T00:00:00Z').getTime();

    for (let i = 0; i < totalRows; i += batchSize) {
      let values = [];
      for (let j = 0; j < batchSize; j++) {
        const ts = new Date(startDate + random() * (endDate - startDate)).toISOString();
        
        const r = random();
        let severity = 'debug';
        if (r > 0.6) severity = 'info';
        if (r > 0.85) severity = 'warn';
        if (r > 0.95) severity = 'error';

        const service = randomChoice(services);
        
        let message = randomChoice(templates);
        message = message.replace('{user}', 'user_' + Math.floor(random() * 1000));
        message = message.replace('{service}', randomChoice(services));
        message = message.replace('{ms}', Math.floor(random() * 5000));
        message = message.replace('{pct}', Math.floor(random() * 100));
        message = message.replace('{key}', 'key_' + Math.floor(random() * 10000));
        message = message.replace('{amount}', '$' + (random() * 100).toFixed(2));
        message = message.replace('{token}', 'tok_' + Math.floor(random() * 100000));
        message = message.replace('{job}', 'job_' + Math.floor(random() * 500));

        message = message.replace(/'/g, "''");

        values.push(`('${ts}', '${severity}', '${service}', '${message}')`);
      }
      await db.exec(`INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')}`);
    }

    console.log("Creating indexes...");
    await db.exec(`CREATE INDEX idx_logs_ts ON logs (ts DESC);`);
    await db.exec(`CREATE INDEX idx_logs_severity_ts ON logs (severity, ts DESC);`);
    
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
      return res.status(400).json({ error: 'Invalid limit' });
    }
    if (severity && !['debug', 'info', 'warn', 'error'].includes(severity)) {
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
      whereClauses.push(`message ILIKE $${paramIndex++}`);
      params.push(`%${q}%`);
    }

    const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

    const countQuery = `SELECT COUNT(*) FROM logs ${whereStr}`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].count, 10);

    const rowsQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${whereStr} 
      ORDER BY ts DESC 
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
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
    severityRes.rows.forEach(row => {
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
  console.error("Failed to initialize database", err);
  process.exit(1);
});
