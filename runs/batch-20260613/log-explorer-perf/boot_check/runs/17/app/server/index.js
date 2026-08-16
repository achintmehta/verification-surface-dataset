const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const DB_PATH = path.join(__dirname, '../.pglite');

let db;

async function initDB() {
  db = new PGlite(DB_PATH);
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
    await db.exec(`
      CREATE TABLE logs (
        id SERIAL PRIMARY KEY,
        ts TIMESTAMP NOT NULL,
        severity VARCHAR(10) NOT NULL,
        service VARCHAR(50) NOT NULL,
        message TEXT NOT NULL
      );
    `);

    console.log('Seeding 100,000 rows...');
    const severities = ['debug', 'info', 'warn', 'error'];
    const services = ['auth', 'api', 'worker', 'db', 'cache', 'search', 'billing', 'frontend'];
    const templates = [
      "User {user} logged in successfully",
      "Failed to authenticate user {user}",
      "Processing job {job} in queue",
      "Job {job} failed with error: {error}",
      "Cache miss for key {key}",
      "Database connection timeout",
      "Payment processed for account {account}",
      "Invalid request payload: {error}",
      "Starting service {service}",
      "Service {service} stopped unexpectedly"
    ];

    let seed = 1;
    function random() {
      const x = Math.sin(seed++) * 10000;
      return x - Math.floor(x);
    }

    function randomChoice(arr) {
      return arr[Math.floor(random() * arr.length)];
    }

    function randomString(len) {
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let res = '';
      for (let i = 0; i < len; i++) {
        res += chars[Math.floor(random() * chars.length)];
      }
      return res;
    }

    const BATCH_SIZE = 5000;
    const TOTAL_ROWS = 100000;
    
    let baseTime = new Date('2023-01-01T00:00:00Z').getTime();
    const timeStep = (30 * 24 * 60 * 60 * 1000) / TOTAL_ROWS;

    for (let i = 0; i < TOTAL_ROWS; i += BATCH_SIZE) {
      let values = [];
      for (let j = 0; j < BATCH_SIZE; j++) {
        const ts = new Date(baseTime + (i + j) * timeStep).toISOString();
        
        const r = random();
        let severity = 'debug';
        if (r > 0.6) severity = 'info';
        if (r > 0.85) severity = 'warn';
        if (r > 0.95) severity = 'error';

        const service = randomChoice(services);
        
        let message = randomChoice(templates);
        message = message.replace('{user}', randomString(8));
        message = message.replace('{job}', randomString(12));
        message = message.replace('{error}', randomString(16));
        message = message.replace('{key}', randomString(10));
        message = message.replace('{account}', randomString(8));
        message = message.replace('{service}', service);

        message = message.replace(/'/g, "''");

        values.push(`('${ts}', '${severity}', '${service}', '${message}')`);
      }
      
      await db.exec(`
        INSERT INTO logs (ts, severity, service, message)
        VALUES ${values.join(',')}
      `);
      console.log(`Seeded ${i + BATCH_SIZE} rows...`);
    }

    console.log('Creating indexes...');
    await db.exec(`
      CREATE INDEX idx_logs_ts ON logs (ts DESC);
      CREATE INDEX idx_logs_severity_ts ON logs (severity, ts DESC);
    `);
    
    console.log('Database initialization complete.');
  } else {
    console.log('Database already initialized.');
  }
}

app.get('/api/stats', async (req, res) => {
  try {
    const totalRes = await db.query('SELECT COUNT(*) as total FROM logs');
    const severityRes = await db.query('SELECT severity, COUNT(*) as count FROM logs GROUP BY severity');
    
    const stats = {
      total: parseInt(totalRes.rows[0].total, 10),
      severities: {}
    };
    
    for (const row of severityRes.rows) {
      stats.severities[row.severity] = parseInt(row.count, 10);
    }
    
    res.json(stats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
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
    if (isNaN(limit) || limit < 1) {
      return res.status(400).json({ error: 'Invalid limit' });
    }
    if (limit > 200) limit = 200;
    
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
      // Escape special characters for LIKE
      const escapedQ = q.replace(/[%_]/g, '\\$&');
      conditions.push(`message ILIKE $${paramIdx++}`);
      params.push(`%${escapedQ}%`);
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
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
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

const PORT = process.env.PORT || 3000;

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
