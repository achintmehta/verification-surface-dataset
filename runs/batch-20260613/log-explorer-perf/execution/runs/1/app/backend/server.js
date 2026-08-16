import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { seedDatabase } from './seed.js';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3001;
const DB_DIR = path.join(__dirname, 'data', 'pglite');

// Ensure data directory exists
fs.mkdirSync(DB_DIR, { recursive: true });

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

let db;

async function initDb() {
  console.log(`Initializing PGLite at ${DB_DIR}...`);
  db = new PGlite(DB_DIR);
  await db.waitReady;
  console.log('PGLite ready.');
  await seedDatabase(db);
}

const app = express();

app.use(cors());
app.use(express.json());

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

/**
 * GET /api/logs
 * Query params:
 *   offset  - integer >= 0 (default 0)
 *   limit   - integer 1..200 (default 100)
 *   severity - one of debug|info|warn|error (optional)
 *   q       - message substring, case-insensitive (optional)
 *
 * Returns: { total: number, rows: Array<{id, ts, severity, service, message}> }
 */
app.get('/api/logs', async (req, res) => {
  try {
    const { offset: rawOffset, limit: rawLimit, severity, q } = req.query;

    // Parse and validate offset
    let offset = 0;
    if (rawOffset !== undefined) {
      offset = parseInt(rawOffset, 10);
      if (!Number.isFinite(offset) || offset < 0 || !Number.isInteger(offset) || String(rawOffset).trim() !== String(offset)) {
        return res.status(400).json({ error: 'Invalid offset: must be a non-negative integer' });
      }
    }

    // Parse and validate limit
    let limit = 100;
    if (rawLimit !== undefined) {
      limit = parseInt(rawLimit, 10);
      if (!Number.isFinite(limit) || limit < 1 || limit > MAX_LIMIT || !Number.isInteger(limit) || String(rawLimit).trim() !== String(limit)) {
        return res.status(400).json({ error: `Invalid limit: must be an integer between 1 and ${MAX_LIMIT}` });
      }
    }

    // Validate severity
    if (severity !== undefined && severity !== '' && !VALID_SEVERITIES.has(severity)) {
      return res.status(400).json({ error: `Invalid severity: must be one of ${[...VALID_SEVERITIES].join(', ')}` });
    }

    // Build WHERE clause
    const conditions = [];
    const params = [];

    if (severity && VALID_SEVERITIES.has(severity)) {
      params.push(severity);
      conditions.push(`severity = $${params.length}`);
    }

    if (q && q.trim()) {
      params.push(`%${q.trim()}%`);
      conditions.push(`message ILIKE $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count query
    const countSql = `SELECT COUNT(*) as total FROM logs ${whereClause}`;
    const countResult = await db.query(countSql, params);
    const total = parseInt(countResult.rows[0].total, 10);

    // Data query with OFFSET/LIMIT
    // For deep offsets with severity filter, the index on (severity, ts DESC) is used
    // For deep offsets without filter, the index on ts DESC is used
    const dataSql = `
      SELECT id, ts, severity, service, message
      FROM logs
      ${whereClause}
      ORDER BY ts DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    const dataResult = await db.query(dataSql, [...params, limit, offset]);

    res.json({
      total,
      rows: dataResult.rows,
    });
  } catch (err) {
    console.error('Error in GET /api/logs:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/stats
 * Returns total row count and per-severity counts.
 */
app.get('/api/stats', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT severity, COUNT(*) as count
      FROM logs
      GROUP BY severity
      ORDER BY severity
    `);

    const bySeverity = {};
    let total = 0;
    for (const row of result.rows) {
      bySeverity[row.severity] = parseInt(row.count, 10);
      total += parseInt(row.count, 10);
    }

    res.json({ total, bySeverity });
  } catch (err) {
    console.error('Error in GET /api/stats:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Log Explorer backend listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
