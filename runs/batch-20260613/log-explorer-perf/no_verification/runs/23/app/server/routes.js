import { Router } from 'express';
import { getDb } from './db.js';

const router = Router();

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

/**
 * GET /api/logs
 * Query params: offset (int >= 0), limit (int 1..200), severity, q (substring)
 * Returns: { total: number, rows: LogEntry[] }
 */
router.get('/logs', async (req, res) => {
  try {
    const db = getDb();

    // Parse and validate offset
    let offset = parseInt(req.query.offset, 10);
    if (isNaN(offset)) offset = 0;
    if (offset < 0) {
      return res.status(400).json({ error: 'offset must be >= 0' });
    }

    // Parse and validate limit
    let limit = parseInt(req.query.limit, 10);
    if (isNaN(limit)) limit = 50;
    if (limit < 1 || limit > MAX_LIMIT) {
      return res.status(400).json({ error: `limit must be between 1 and ${MAX_LIMIT}` });
    }

    // Validate severity
    const severity = req.query.severity || null;
    if (severity && !VALID_SEVERITIES.has(severity)) {
      return res.status(400).json({ error: `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}` });
    }

    // Substring query
    const q = req.query.q || null;

    // Build WHERE clause
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
    const countSql = `SELECT count(*)::int AS total FROM logs ${whereClause}`;
    const countResult = await db.query(countSql, params);
    const total = countResult.rows[0].total;

    // Get rows with LIMIT/OFFSET
    const dataSql = `SELECT id, ts, severity, service, message FROM logs ${whereClause} ORDER BY ts DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
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

/**
 * GET /api/stats
 * Returns: { total: number, bySeverity: { debug: n, info: n, warn: n, error: n } }
 */
router.get('/stats', async (req, res) => {
  try {
    const db = getDb();

    const result = await db.query(`
      SELECT 
        count(*)::int AS total,
        count(*) FILTER (WHERE severity = 'debug')::int AS debug_count,
        count(*) FILTER (WHERE severity = 'info')::int AS info_count,
        count(*) FILTER (WHERE severity = 'warn')::int AS warn_count,
        count(*) FILTER (WHERE severity = 'error')::int AS error_count
      FROM logs
    `);

    const row = result.rows[0];
    res.json({
      total: row.total,
      bySeverity: {
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

export default router;
