import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';
import { seedDatabase } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'logs.db');

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);

async function main() {
  console.log('Initializing PGLite database at', DB_PATH);
  const db = new PGlite(`file://${DB_PATH}`);

  // Initialize schema and seed
  await initSchema(db);
  await seedDatabase(db);

  const app = express();
  app.use(cors());
  app.use(express.json());

  // GET /api/logs
  app.get('/api/logs', async (req, res) => {
    try {
      const { offset: rawOffset, limit: rawLimit, severity, q } = req.query;

      // Parse and validate offset
      const offset = rawOffset !== undefined ? parseInt(rawOffset, 10) : 0;
      if (isNaN(offset) || offset < 0) {
        return res.status(400).json({ error: 'offset must be a non-negative integer' });
      }

      // Parse and validate limit
      const limit = rawLimit !== undefined ? parseInt(rawLimit, 10) : 100;
      if (isNaN(limit) || limit < 1) {
        return res.status(400).json({ error: 'limit must be a positive integer' });
      }
      if (limit > 200) {
        return res.status(400).json({ error: 'limit cannot exceed 200' });
      }

      // Validate severity
      if (severity !== undefined && severity !== '' && !VALID_SEVERITIES.has(severity)) {
        return res.status(400).json({ error: `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}` });
      }

      // Build WHERE clause
      const conditions = [];
      const params = [];
      let paramIdx = 1;

      if (severity && severity !== '') {
        conditions.push(`severity = $${paramIdx++}`);
        params.push(severity);
      }

      if (q && q !== '') {
        conditions.push(`message ILIKE $${paramIdx++}`);
        params.push(`%${q}%`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Count query
      const countSql = `SELECT COUNT(*) as total FROM logs ${whereClause}`;
      const countResult = await db.query(countSql, params);
      const total = parseInt(countResult.rows[0].total, 10);

      // Data query - ordered by ts descending
      const dataSql = `
        SELECT id, ts, severity, service, message
        FROM logs
        ${whereClause}
        ORDER BY ts DESC, id DESC
        LIMIT $${paramIdx++} OFFSET $${paramIdx++}
      `;
      const dataParams = [...params, limit, offset];
      const dataResult = await db.query(dataSql, dataParams);

      return res.json({
        total,
        rows: dataResult.rows
      });
    } catch (err) {
      console.error('Error in GET /api/logs:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/stats
  app.get('/api/stats', async (req, res) => {
    try {
      const totalResult = await db.query('SELECT COUNT(*) as total FROM logs');
      const total = parseInt(totalResult.rows[0].total, 10);

      const severityResult = await db.query(
        `SELECT severity, COUNT(*) as count FROM logs GROUP BY severity ORDER BY severity`
      );

      const bySeverity = {};
      for (const row of severityResult.rows) {
        bySeverity[row.severity] = parseInt(row.count, 10);
      }

      return res.json({ total, bySeverity });
    } catch (err) {
      console.error('Error in GET /api/stats:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`Log Explorer API server running on http://localhost:${PORT}`);
  });
}

async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id        BIGINT PRIMARY KEY,
      ts        TIMESTAMP NOT NULL,
      severity  TEXT NOT NULL,
      service   TEXT NOT NULL,
      message   TEXT NOT NULL
    );

    -- Index for ordering by ts (primary sort)
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC, id DESC);

    -- Index for severity + ts ordering
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC, id DESC);

    -- Index for ts ascending (used in seeding checks)
    CREATE INDEX IF NOT EXISTS idx_logs_id ON logs (id);
  `);
  console.log('Schema initialized');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
