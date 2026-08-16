const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDB, getDB } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Valid severities
const VALID_SEVERITIES = ['debug', 'info', 'warn', 'error'];
const MAX_LIMIT = 200;

// GET /api/logs?offset=&limit=&severity=&q=
app.get('/api/logs', async (req, res) => {
  try {
    const db = getDB();
    
    // Parse and validate parameters
    let offset = parseInt(req.query.offset, 10);
    let limit = parseInt(req.query.limit, 10);
    const severity = req.query.severity || null;
    const q = req.query.q || null;

    // Default values
    if (isNaN(offset)) offset = 0;
    if (isNaN(limit)) limit = 50;

    // Validation
    if (offset < 0) {
      return res.status(400).json({ error: 'offset must be non-negative' });
    }
    if (limit < 1 || limit > MAX_LIMIT) {
      return res.status(400).json({ error: `limit must be between 1 and ${MAX_LIMIT}` });
    }
    if (severity && !VALID_SEVERITIES.includes(severity)) {
      return res.status(400).json({ error: `severity must be one of: ${VALID_SEVERITIES.join(', ')}` });
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

    // Get total count
    const countQuery = `SELECT COUNT(*)::int AS total FROM logs ${whereClause}`;
    const countResult = await db.query(countQuery, params);
    const total = countResult.rows[0].total;

    // Get rows
    const dataParams = [...params, limit, offset];
    const dataQuery = `SELECT id, ts, severity, service, message FROM logs ${whereClause} ORDER BY ts DESC, id DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
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
    const db = getDB();
    const result = await db.query(`
      SELECT 
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE severity = 'debug')::int AS debug,
        COUNT(*) FILTER (WHERE severity = 'info')::int AS info,
        COUNT(*) FILTER (WHERE severity = 'warn')::int AS warn,
        COUNT(*) FILTER (WHERE severity = 'error')::int AS error
      FROM logs
    `);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error querying stats:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

async function start() {
  console.time('boot');
  await initDB();
  console.timeEnd('boot');

  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
