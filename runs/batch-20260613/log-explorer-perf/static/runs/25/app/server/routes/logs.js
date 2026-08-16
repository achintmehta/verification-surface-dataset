const express = require('express');

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

function createLogsRouter(db) {
  const router = express.Router();

  /**
   * GET /api/logs?offset=&limit=&severity=&q=
   * Returns { total, rows } ordered by ts DESC.
   */
  router.get('/logs', async (req, res) => {
    try {
      // Parse and validate parameters
      const offset = parseInt(req.query.offset, 10) || 0;
      const limit = parseInt(req.query.limit, 10) || 100;
      const severity = req.query.severity || null;
      const q = req.query.q || null;

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
        conditions.push(`severity = $${paramIdx}`);
        params.push(severity);
        paramIdx++;
      }

      if (q && q.trim().length > 0) {
        conditions.push(`message ILIKE $${paramIdx}`);
        params.push(`%${q.trim()}%`);
        paramIdx++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Get total count
      const countSql = `SELECT COUNT(*)::int AS total FROM logs ${whereClause}`;
      const countResult = await db.query(countSql, params);
      const total = countResult.rows[0].total;

      // Get rows
      const dataSql = `SELECT id, ts, severity, service, message FROM logs ${whereClause} ORDER BY ts DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
      const dataParams = [...params, limit, offset];
      const dataResult = await db.query(dataSql, dataParams);

      res.json({
        total,
        rows: dataResult.rows,
      });
    } catch (err) {
      console.error('[api] Error in GET /api/logs:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/stats
   * Returns total row count and per-severity counts.
   */
  router.get('/stats', async (_req, res) => {
    try {
      const result = await db.query(`
        SELECT severity, COUNT(*)::int AS count
        FROM logs
        GROUP BY severity
        ORDER BY severity
      `);

      const bySeverity = {};
      let total = 0;
      for (const row of result.rows) {
        bySeverity[row.severity] = row.count;
        total += row.count;
      }

      res.json({ total, bySeverity });
    } catch (err) {
      console.error('[api] Error in GET /api/stats:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { createLogsRouter };
