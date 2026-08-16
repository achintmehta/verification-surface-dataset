const express = require('express');

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

function createApiRouter(db) {
  const router = express.Router();

  /**
   * GET /api/logs
   * Query params: offset, limit, severity, q
   * Returns: { total: number, rows: Array }
   */
  router.get('/logs', async (req, res) => {
    try {
      // Parse and validate parameters
      const offset = req.query.offset !== undefined ? parseInt(req.query.offset, 10) : 0;
      const limit = req.query.limit !== undefined ? parseInt(req.query.limit, 10) : 100;
      const severity = req.query.severity || null;
      const q = req.query.q || null;

      // Validation
      if (isNaN(offset) || offset < 0) {
        return res.status(400).json({ error: 'offset must be a non-negative integer' });
      }
      if (isNaN(limit) || limit < 1 || limit > MAX_LIMIT) {
        return res.status(400).json({ error: `limit must be between 1 and ${MAX_LIMIT}` });
      }
      if (severity !== null && !VALID_SEVERITIES.has(severity)) {
        return res.status(400).json({ error: `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}` });
      }

      // Build query
      const conditions = [];
      const params = [];
      let paramIndex = 1;

      if (severity) {
        conditions.push(`severity = $${paramIndex}`);
        params.push(severity);
        paramIndex++;
      }

      if (q) {
        conditions.push(`message ILIKE $${paramIndex}`);
        params.push(`%${q}%`);
        paramIndex++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Get total count
      const countQuery = `SELECT COUNT(*)::int AS total FROM logs ${whereClause}`;
      const countResult = await db.query(countQuery, params);
      const total = countResult.rows[0].total;

      // Get rows
      const dataQuery = `SELECT id, ts, severity, service, message FROM logs ${whereClause} ORDER BY ts DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      const dataParams = [...params, limit, offset];
      const dataResult = await db.query(dataQuery, dataParams);

      res.json({
        total,
        rows: dataResult.rows,
      });
    } catch (err) {
      console.error('[api] Error in /api/logs:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/stats
   * Returns: { total: number, bySeverity: { debug: number, info: number, warn: number, error: number } }
   */
  router.get('/stats', async (req, res) => {
    try {
      const result = await db.query(`
        SELECT severity, COUNT(*)::int AS count
        FROM logs
        GROUP BY severity
      `);

      const bySeverity = { debug: 0, info: 0, warn: 0, error: 0 };
      let total = 0;
      for (const row of result.rows) {
        bySeverity[row.severity] = row.count;
        total += row.count;
      }

      res.json({ total, bySeverity });
    } catch (err) {
      console.error('[api] Error in /api/stats:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { createApiRouter };
