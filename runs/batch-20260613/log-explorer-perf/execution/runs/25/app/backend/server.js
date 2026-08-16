const express = require('express');
const cors = require('cors');
const { getDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

// GET /api/logs?offset=&limit=&severity=&q=
app.get('/api/logs', async (req, res) => {
  try {
    const db = await getDb();

    // Parse and validate parameters
    let offset = parseInt(req.query.offset, 10);
    let limit = parseInt(req.query.limit, 10);
    const severity = req.query.severity || null;
    const q = req.query.q || null;

    if (isNaN(offset)) offset = 0;
    if (isNaN(limit)) limit = 50;

    // Validation
    if (offset < 0) {
      return res.status(400).json({ error: 'offset must be non-negative' });
    }
    if (limit < 1 || limit > MAX_LIMIT) {
      return res.status(400).json({ error: `limit must be between 1 and ${MAX_LIMIT}` });
    }
    if (severity && !VALID_SEVERITIES.has(severity)) {
      return res.status(400).json({ error: `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}` });
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

    const whereClause = conditions.length > 0
      ? 'WHERE ' + conditions.join(' AND ')
      : '';

    // Get total count
    const countSql = `SELECT COUNT(*)::int AS total FROM logs ${whereClause}`;
    const countResult = await db.query(countSql, params);
    const total = countResult.rows[0].total;

    // Get rows
    const dataSql = `SELECT id, ts, severity, service, message FROM logs ${whereClause} ORDER BY ts DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    const dataParams = [...params, limit, offset];
    const dataResult = await db.query(dataSql, dataParams);

    res.json({
      total,
      rows: dataResult.rows,
    });
  } catch (err) {
    console.error('[api/logs] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/stats
app.get('/api/stats', async (req, res) => {
  try {
    const db = await getDb();

    const result = await db.query(`
      SELECT 
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE severity = 'debug')::int AS debug,
        COUNT(*) FILTER (WHERE severity = 'info')::int AS info,
        COUNT(*) FILTER (WHERE severity = 'warn')::int AS warn,
        COUNT(*) FILTER (WHERE severity = 'error')::int AS error
      FROM logs
    `);

    const row = result.rows[0];
    res.json({
      total: row.total,
      severities: {
        debug: row.debug,
        info: row.info,
        warn: row.warn,
        error: row.error,
      },
    });
  } catch (err) {
    console.error('[api/stats] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function start() {
  console.log('[server] Starting...');
  const startTime = Date.now();

  // Initialize DB (this triggers seeding on first boot)
  await getDb();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[server] DB ready in ${elapsed}s`);

  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('[server] Failed to start:', err);
  process.exit(1);
});

module.exports = app;
