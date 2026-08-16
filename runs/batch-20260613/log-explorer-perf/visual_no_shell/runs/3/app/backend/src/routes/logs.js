import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

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
router.get('/logs', async (req, res) => {
  try {
    const { offset: rawOffset, limit: rawLimit, severity, q } = req.query;

    // Parse and validate offset
    let offset = 0;
    if (rawOffset !== undefined) {
      offset = parseInt(rawOffset, 10);
      if (!Number.isInteger(offset) || isNaN(offset) || offset < 0 || String(offset) !== rawOffset) {
        return res.status(400).json({ error: 'Invalid offset: must be a non-negative integer' });
      }
    }

    // Parse and validate limit
    let limit = 100;
    if (rawLimit !== undefined) {
      limit = parseInt(rawLimit, 10);
      if (!Number.isInteger(limit) || isNaN(limit) || limit < 1 || limit > MAX_LIMIT || String(limit) !== rawLimit) {
        return res.status(400).json({ error: `Invalid limit: must be an integer between 1 and ${MAX_LIMIT}` });
      }
    }

    // Validate severity
    if (severity !== undefined && severity !== '' && !VALID_SEVERITIES.has(severity)) {
      return res.status(400).json({ error: `Invalid severity: must be one of ${[...VALID_SEVERITIES].join(', ')}` });
    }

    const db = getDb();

    // Build WHERE clause
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (severity && VALID_SEVERITIES.has(severity)) {
      conditions.push(`severity = $${paramIdx++}`);
      params.push(severity);
    }

    if (q && q.trim()) {
      conditions.push(`message ILIKE $${paramIdx++}`);
      params.push(`%${q.trim()}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count query
    const countSql = `SELECT COUNT(*) as total FROM logs ${whereClause}`;
    const countResult = await db.query(countSql, params);
    const total = parseInt(countResult.rows[0].total, 10);

    // Data query with windowing
    const dataSql = `
      SELECT id, ts, severity, service, message
      FROM logs
      ${whereClause}
      ORDER BY ts DESC, id DESC
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `;
    const dataParams = [...params, limit, offset];
    const dataResult = await db.query(dataSql, dataParams);

    return res.json({
      total,
      rows: dataResult.rows,
    });
  } catch (err) {
    console.error('Error in GET /api/logs:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/stats
 * Returns total row count and per-severity counts.
 */
router.get('/stats', async (req, res) => {
  try {
    const db = getDb();

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
    return res.json({
      total: parseInt(row.total, 10),
      bySeverity: {
        debug: parseInt(row.debug, 10),
        info: parseInt(row.info, 10),
        warn: parseInt(row.warn, 10),
        error: parseInt(row.error, 10),
      },
    });
  } catch (err) {
    console.error('Error in GET /api/stats:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
