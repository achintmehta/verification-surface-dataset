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

      // Combined count + data query using a single CTE pass
      // This avoids scanning the table twice for filtered queries
      const combinedSql = `
        WITH filtered AS (
          SELECT id, ts, severity, service, message,
                 COUNT(*) OVER () AS total_count
          FROM logs
          ${whereClause}
          ORDER BY ts DESC, id DESC
        )
        SELECT id, ts, severity, service, message, total_count::int AS total
        FROM filtered
        LIMIT $${paramIdx++} OFFSET $${paramIdx++}
      `;
      const combinedParams = [...params, limit, offset];

      const t0 = Date.now();
      const result = await db.query(combinedSql, combinedParams);
      const elapsed = Date.now() - t0;

      // Extract total from first row (or do a separate count if no rows returned)
      let total = 0;
      let rows = result.rows;

      if (rows.length > 0) {
        total = rows[0].total;
        // Strip the total_count column from rows
        rows = rows.map(({ total: _t, ...rest }) => rest);
      } else {
        // No rows at this offset — need to get the count separately
        const countSql = `SELECT COUNT(*)::int AS total FROM logs ${whereClause}`;
        const countResult = await db.query(countSql, params);
        total = countResult.rows[0].total;
      }

      if (elapsed > 100) {
        console.log(`Slow query (${elapsed}ms): offset=${offset} limit=${limit} severity=${severity || '-'} q=${q || '-'}`);
      }

      return res.json({ total, rows });
    } catch (err) {
      console.error('Error in GET /api/logs:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/stats
  app.get('/api/stats', async (req, res) => {
    try {
      const totalResult = await db.query('SELECT COUNT(*)::int AS total FROM logs');
      const total = totalResult.rows[0].total;

      const severityResult = await db.query(`
        SELECT severity, COUNT(*)::int AS count
        FROM logs
        GROUP BY severity
        ORDER BY severity
      `);

      const bySeverity = {};
      for (const row of severityResult.rows) {
        bySeverity[row.severity] = row.count;
      }

      return res.json({ total, bySeverity });
    } catch (err) {
      console.error('Error in GET /api/stats:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`Log Explorer API listening on http://localhost:${PORT}`);
  });
}

async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id        SERIAL PRIMARY KEY,
      ts        TIMESTAMPTZ NOT NULL,
      severity  TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service   TEXT NOT NULL,
      message   TEXT NOT NULL
    );

    -- Primary ordering index: ts DESC, id DESC (covers all unfiltered queries)
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC, id DESC);

    -- Severity + ts index (covers severity-filtered queries efficiently)
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC, id DESC);
  `);

  // Try to enable pg_trgm for fast ILIKE substring search
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_message_trgm
        ON logs USING gin (message gin_trgm_ops);
    `);
    console.log('pg_trgm extension enabled — GIN index on message for fast substring search');
  } catch (e) {
    console.log('pg_trgm not available; ILIKE will use sequential scan (still within budget for 100k rows)');
  }
}

main().catch(err => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
