const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

let db = null;
let cachedTotalCount = null;

// Valid severities
const VALID_SEVERITIES = ['debug', 'info', 'warn', 'error'];
const MAX_LIMIT = 200;

// GET /api/logs?offset=&limit=&severity=&q=
app.get('/api/logs', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not ready' });
    }

    // Parse and validate parameters
    const offset = parseInt(req.query.offset || '0', 10);
    const limit = parseInt(req.query.limit || '50', 10);
    const severity = req.query.severity || null;
    const q = req.query.q || null;

    // Validation
    if (isNaN(offset) || offset < 0) {
      return res.status(400).json({ error: 'Invalid offset: must be a non-negative integer' });
    }
    if (isNaN(limit) || limit < 1 || limit > MAX_LIMIT) {
      return res.status(400).json({ error: `Invalid limit: must be between 1 and ${MAX_LIMIT}` });
    }
    if (severity !== null && !VALID_SEVERITIES.includes(severity)) {
      return res.status(400).json({ error: `Invalid severity: must be one of ${VALID_SEVERITIES.join(', ')}` });
    }

    // Build query
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

    // Get total count (use cached value when unfiltered)
    let total;
    if (conditions.length === 0 && cachedTotalCount !== null) {
      total = cachedTotalCount;
    } else {
      const countQuery = `SELECT COUNT(*) as total FROM logs ${whereClause}`;
      const countResult = await db.query(countQuery, params);
      total = parseInt(countResult.rows[0].total, 10);
      if (conditions.length === 0) {
        cachedTotalCount = total;
      }
    }

    // Get rows
    const dataQuery = `SELECT id, ts, severity, service, message FROM logs ${whereClause} ORDER BY ts DESC, id DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    const dataParams = [...params, limit, offset];
    const dataResult = await db.query(dataQuery, dataParams);

    res.json({
      total,
      rows: dataResult.rows
    });
  } catch (err) {
    console.error('Error querying logs:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/stats
app.get('/api/stats', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not ready' });
    }

    const result = await db.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE severity = 'debug') as debug,
        COUNT(*) FILTER (WHERE severity = 'info') as info,
        COUNT(*) FILTER (WHERE severity = 'warn') as warn,
        COUNT(*) FILTER (WHERE severity = 'error') as error
      FROM logs
    `);

    const row = result.rows[0];
    res.json({
      total: parseInt(row.total, 10),
      debug: parseInt(row.debug, 10),
      info: parseInt(row.info, 10),
      warn: parseInt(row.warn, 10),
      error: parseInt(row.error, 10)
    });
  } catch (err) {
    console.error('Error fetching stats:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function start() {
  console.time('boot');
  db = await initDB();
  console.timeEnd('boot');

  app.listen(PORT, () => {
    console.log(`Log Explorer backend listening on http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
