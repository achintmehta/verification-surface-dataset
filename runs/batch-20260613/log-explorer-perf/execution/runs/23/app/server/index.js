const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDb, getDb, isReady } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static frontend files in production
app.use(express.static(path.join(__dirname, '..', 'client')));

const VALID_SEVERITIES = ['debug', 'info', 'warn', 'error'];
const MAX_LIMIT = 200;

// Health check / readiness
app.get('/api/health', (req, res) => {
  res.json({ ready: isReady() });
});

// Stats endpoint
app.get('/api/stats', async (req, res) => {
  try {
    const db = getDb();
    const totalResult = await db.query('SELECT count(*)::int AS total FROM logs');
    const severityResult = await db.query(
      `SELECT severity, count(*)::int AS count FROM logs GROUP BY severity ORDER BY severity`
    );
    const severityCounts = {};
    for (const row of severityResult.rows) {
      severityCounts[row.severity] = row.count;
    }
    res.json({
      total: totalResult.rows[0].total,
      severities: severityCounts,
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Main logs query endpoint
app.get('/api/logs', async (req, res) => {
  try {
    // Parse and validate parameters
    let offset = parseInt(req.query.offset, 10);
    let limit = parseInt(req.query.limit, 10);
    const severity = req.query.severity || null;
    const q = req.query.q || null;

    // Defaults
    if (isNaN(offset)) offset = 0;
    if (isNaN(limit)) limit = 50;

    // Validation
    if (offset < 0) {
      return res.status(400).json({ error: 'offset must be non-negative' });
    }
    if (limit < 1 || limit > MAX_LIMIT) {
      return res.status(400).json({ error: `limit must be between 1 and ${MAX_LIMIT}` });
    }
    if (severity !== null && !VALID_SEVERITIES.includes(severity)) {
      return res.status(400).json({ error: `severity must be one of: ${VALID_SEVERITIES.join(', ')}` });
    }

    const db = getDb();

    // Build query
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (severity) {
      conditions.push(`severity = $${paramIdx}`);
      params.push(severity);
      paramIdx++;
    }

    if (q) {
      conditions.push(`message ILIKE $${paramIdx}`);
      params.push(`%${q}%`);
      paramIdx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count for this filter combination
    const countQuery = `SELECT count(*)::int AS total FROM logs ${whereClause}`;
    const countResult = await db.query(countQuery, params);
    const total = countResult.rows[0].total;

    // Get rows for the requested window
    const dataParams = [...params, limit, offset];
    const dataQuery = `
      SELECT id, ts, severity, service, message
      FROM logs
      ${whereClause}
      ORDER BY ts DESC
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `;

    const dataResult = await db.query(dataQuery, dataParams);

    res.json({
      total,
      rows: dataResult.rows,
    });
  } catch (err) {
    console.error('Logs query error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Initialize database then start server
async function start() {
  try {
    console.time('server:start');
    await initDb();
    app.listen(PORT, () => {
      console.timeEnd('server:start');
      console.log(`Log Explorer API running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
