const express = require('express');
const { getDb } = require('./db');

const router = express.Router();

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;

router.get('/logs', async (req, res) => {
  try {
    // Parse and validate parameters
    let offset = parseInt(req.query.offset, 10);
    let limit = parseInt(req.query.limit, 10);
    const severity = req.query.severity || null;
    const q = req.query.q || null;

    // Defaults
    if (isNaN(offset)) offset = 0;
    if (isNaN(limit)) limit = DEFAULT_LIMIT;

    // Validation
    if (offset < 0) {
      return res.status(400).json({ error: 'offset must be non-negative' });
    }
    if (limit < 1 || limit > MAX_LIMIT) {
      return res.status(400).json({ error: `limit must be between 1 and ${MAX_LIMIT}` });
    }
    if (severity !== null && !VALID_SEVERITIES.has(severity)) {
      return res.status(400).json({ error: `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}` });
    }

    const db = getDb();

    // Build query dynamically
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
    const countSql = `SELECT COUNT(*)::int AS total FROM logs ${whereClause}`;
    const countResult = await db.query(countSql, params);
    const total = countResult.rows[0].total;

    // Get rows
    const dataSql = `SELECT id, ts, severity, service, message FROM logs ${whereClause} ORDER BY ts DESC, id DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    const dataParams = [...params, limit, offset];
    const dataResult = await db.query(dataSql, dataParams);

    res.json({
      total,
      rows: dataResult.rows,
    });
  } catch (err) {
    console.error('Error in /api/logs:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const db = getDb();

    const result = await db.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE severity = 'debug')::int AS debug_count,
        COUNT(*) FILTER (WHERE severity = 'info')::int AS info_count,
        COUNT(*) FILTER (WHERE severity = 'warn')::int AS warn_count,
        COUNT(*) FILTER (WHERE severity = 'error')::int AS error_count
      FROM logs
    `);

    const row = result.rows[0];
    res.json({
      total: row.total,
      severities: {
        debug: row.debug_count,
        info: row.info_count,
        warn: row.warn_count,
        error: row.error_count,
      },
    });
  } catch (err) {
    console.error('Error in /api/stats:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
