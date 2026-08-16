import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';
import { seedDatabase } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'pgdata');

const app = express();
app.use(cors());
app.use(express.json());

let db;

const VALID_SEVERITIES = ['debug', 'info', 'warn', 'error'];

async function initDB() {
  console.time('db-init');
  db = new PGlite(DATA_DIR);

  // Check if table exists and is populated
  const tableCheck = await db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_name = 'logs'
    ) AS table_exists
  `);

  if (!tableCheck.rows[0].table_exists) {
    console.log('Creating schema and seeding database...');
    console.time('schema-and-seed');

    await db.query(`
      CREATE TABLE logs (
        id SERIAL PRIMARY KEY,
        ts TIMESTAMPTZ NOT NULL,
        severity VARCHAR(5) NOT NULL,
        service VARCHAR(50) NOT NULL,
        message TEXT NOT NULL
      )
    `);

    await seedDatabase(db);

    // Create indexes after bulk insert for faster seeding
    console.time('create-indexes');
    await db.query(`CREATE INDEX idx_logs_ts ON logs (ts DESC)`);
    await db.query(`CREATE INDEX idx_logs_severity_ts ON logs (severity, ts DESC)`);
    // For substring search - use pg_trgm if available, otherwise we rely on ILIKE with ordering index
    // PGLite may not support pg_trgm, so we create a functional index approach
    await db.query(`CREATE INDEX idx_logs_message_lower ON logs (lower(message) text_pattern_ops)`);
    console.timeEnd('create-indexes');

    console.timeEnd('schema-and-seed');
  } else {
    // Check row count
    const countResult = await db.query('SELECT COUNT(*) as cnt FROM logs');
    console.log(`Database already populated with ${countResult.rows[0].cnt} rows.`);

    if (parseInt(countResult.rows[0].cnt) === 0) {
      console.log('Table exists but is empty, reseeding...');
      await seedDatabase(db);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_message_lower ON logs (lower(message) text_pattern_ops)`);
    }
  }

  console.timeEnd('db-init');
}

// GET /api/logs?offset=&limit=&severity=&q=
app.get('/api/logs', async (req, res) => {
  try {
    const rawOffset = req.query.offset;
    const rawLimit = req.query.limit;
    let offset = rawOffset !== undefined ? parseInt(rawOffset, 10) : 0;
    let limit = rawLimit !== undefined ? parseInt(rawLimit, 10) : 50;
    const severity = req.query.severity || '';
    const q = req.query.q || '';

    // Validation
    if (isNaN(offset) || offset < 0) {
      return res.status(400).json({ error: 'offset must be non-negative' });
    }
    if (isNaN(limit) || limit < 1 || limit > 200) {
      return res.status(400).json({ error: 'limit must be between 1 and 200' });
    }
    if (severity && !VALID_SEVERITIES.includes(severity)) {
      return res.status(400).json({ error: `severity must be one of: ${VALID_SEVERITIES.join(', ')}` });
    }

    // Cap limit
    limit = Math.min(limit, 200);

    const conditions = [];
    const params = [];
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

    // Run count and data queries in parallel
    const countQuery = `SELECT COUNT(*) as total FROM logs ${whereClause}`;
    const dataQuery = `SELECT id, ts, severity, service, message FROM logs ${whereClause} ORDER BY ts DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;

    const dataParams = [...params, limit, offset];

    const [countResult, dataResult] = await Promise.all([
      db.query(countQuery, params),
      db.query(dataQuery, dataParams)
    ]);

    res.json({
      total: parseInt(countResult.rows[0].total),
      rows: dataResult.rows
    });
  } catch (err) {
    console.error('Query error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/stats
app.get('/api/stats', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE severity = 'debug') as debug_count,
        COUNT(*) FILTER (WHERE severity = 'info') as info_count,
        COUNT(*) FILTER (WHERE severity = 'warn') as warn_count,
        COUNT(*) FILTER (WHERE severity = 'error') as error_count
      FROM logs
    `);

    const row = result.rows[0];
    res.json({
      total: parseInt(row.total),
      counts: {
        debug: parseInt(row.debug_count),
        info: parseInt(row.info_count),
        warn: parseInt(row.warn_count),
        error: parseInt(row.error_count)
      }
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Serve static files in production
app.use(express.static(path.join(__dirname, '..', 'dist')));

const PORT = process.env.PORT || 3000;

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
