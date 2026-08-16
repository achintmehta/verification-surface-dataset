import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, 'pglite-data');

const app = express();
app.use(cors());
app.use(express.json());

let db;

async function initDB() {
  db = new PGlite(dbPath);
  await db.waitReady;
  
  // Create table
  await db.query(`
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
    console.log('Seeding database...');
    const severities = ['debug', 'info', 'warn', 'error'];
    const services = ['auth', 'api', 'worker', 'db', 'cache', 'frontend', 'billing', 'search'];
    const templates = [
      'User {user} logged in',
      'Failed to connect to {service}',
      'Processed {count} records',
      'Invalid payload: {payload}',
      'Timeout waiting for {service}',
      'Cache miss for key {key}',
      'Starting job {job}',
      'Job {job} completed in {time}ms'
    ];

    // Deterministic random
    let seed = 1;
    function random() {
      const x = Math.sin(seed++) * 10000;
      return x - Math.floor(x);
    }

    const batchSize = 5000;
    const totalRows = 100000;
    const now = new Date('2024-01-01T00:00:00Z').getTime();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;

    for (let i = 0; i < totalRows; i += batchSize) {
      let values = [];
      for (let j = 0; j < batchSize; j++) {
        const ts = new Date(now - random() * thirtyDays).toISOString();
        
        const r = random();
        let severity = 'debug';
        if (r > 0.6) severity = 'info';
        if (r > 0.85) severity = 'warn';
        if (r > 0.95) severity = 'error';

        const service = services[Math.floor(random() * services.length)];
        
        const template = templates[Math.floor(random() * templates.length)];
        const message = template
          .replace('{user}', `user_${Math.floor(random() * 1000)}`)
          .replace('{service}', services[Math.floor(random() * services.length)])
          .replace('{count}', Math.floor(random() * 10000))
          .replace('{payload}', `payload_${Math.floor(random() * 1000)}`)
          .replace('{key}', `key_${Math.floor(random() * 10000)}`)
          .replace('{job}', `job_${Math.floor(random() * 1000)}`)
          .replace('{time}', Math.floor(random() * 5000));

        values.push(`('${ts}', '${severity}', '${service}', '${message.replace(/'/g, "''")}')`);
      }
      
      await db.query(`
        INSERT INTO logs (ts, severity, service, message)
        VALUES ${values.join(', ')}
      `);
      console.log(`Seeded ${i + batchSize} rows`);
    }

    console.log('Creating indexes...');
    try {
      await db.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops);`);
      console.log('Created pg_trgm index.');
    } catch (e) {
      console.log('pg_trgm not available, skipping GIN index.', e.message);
    }
    await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);`);
    console.log('Database seeded and indexed.');
  } else {
    console.log(`Database already seeded with ${count} rows.`);
  }
}

let cachedTotalCount = null;

app.get('/api/logs', async (req, res) => {
  try {
    let { offset = 0, limit = 50, severity, q } = req.query;
    offset = parseInt(offset, 10);
    limit = parseInt(limit, 10);

    if (isNaN(offset) || offset < 0) return res.status(400).json({ error: 'Invalid offset' });
    if (isNaN(limit) || limit < 0) return res.status(400).json({ error: 'Invalid limit' });
    if (limit > 200) limit = 200;
    if (severity && !['debug', 'info', 'warn', 'error'].includes(severity)) {
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

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    let total = 0;
    if (conditions.length === 0 && cachedTotalCount !== null) {
      total = cachedTotalCount;
    } else {
      const countQuery = `SELECT COUNT(*) as total FROM logs ${whereClause}`;
      const countRes = await db.query(countQuery, params);
      total = parseInt(countRes.rows[0].total, 10);
      if (conditions.length === 0) {
        cachedTotalCount = total;
      }
    }

    const dataQuery = `
      SELECT l.* FROM (
        SELECT id FROM logs 
        ${whereClause} 
        ORDER BY ts DESC 
        LIMIT $${paramIdx++} OFFSET $${paramIdx++}
      ) sub JOIN logs l ON l.id = sub.id 
      ORDER BY l.ts DESC
    `;

    const dataRes = await db.query(dataQuery, [...params, limit, offset]);

    res.json({
      total,
      rows: dataRes.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const totalRes = await db.query(`SELECT COUNT(*) as total FROM logs`);
    const severityRes = await db.query(`SELECT severity, COUNT(*) as count FROM logs GROUP BY severity`);
    
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

const PORT = process.env.PORT || 3001;
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database', err);
  process.exit(1);
});
