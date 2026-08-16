const express = require('express');

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

function createRouter(db) {
  const router = express.Router();

  router.get('/logs', async (req, res) => {
    try {
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
      if (severity !== null && !VALID_SEVERITIES.has(severity)) {
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

      if (q) {
        conditions.push(`LOWER(message) LIKE $${paramIdx}`);
        params.push(`%${q.toLowerCase()}%`);
        paramIdx++;
      }

      const whereClause = conditions.length > 0
        ? 'WHERE ' + conditions.join(' AND ')
        : '';

      // Get total count
      const countQuery = `SELECT COUNT(*)::int AS total FROM logs ${whereClause}`;
      const countResult = await db.query(countQuery, params);
      const total = countResult.rows[0].total;

      // Get rows
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
      console.error('Error in /api/logs:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/stats', async (req, res) => {
    try {
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
      console.error('Error in /api/stats:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { createRouter };
