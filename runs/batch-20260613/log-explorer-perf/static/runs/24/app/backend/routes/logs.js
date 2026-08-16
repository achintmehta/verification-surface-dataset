import { Router } from 'express';

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;

export function createLogsRouter(db) {
  const router = Router();

  // GET /api/logs?offset=&limit=&severity=&q=
  router.get('/logs', async (req, res) => {
    try {
      // Parse parameters
      let offset = req.query.offset !== undefined ? parseInt(req.query.offset, 10) : 0;
      let limit = req.query.limit !== undefined ? parseInt(req.query.limit, 10) : DEFAULT_LIMIT;
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

      // Build WHERE clause
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

      // Run count and data queries in parallel for better latency
      const countQuery = `SELECT count(*)::int AS total FROM logs ${whereClause}`;
      const dataQuery = `
        SELECT id, ts, severity, service, message 
        FROM logs 
        ${whereClause}
        ORDER BY ts DESC
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
      `;
      const dataParams = [...params, limit, offset];

      const [countResult, dataResult] = await Promise.all([
        db.query(countQuery, params),
        db.query(dataQuery, dataParams),
      ]);

      const total = countResult.rows[0].total;

      res.json({
        total,
        rows: dataResult.rows,
      });
    } catch (err) {
      console.error('Error in GET /api/logs:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/stats
  router.get('/stats', async (req, res) => {
    try {
      const [totalResult, severityResult] = await Promise.all([
        db.query('SELECT count(*)::int AS total FROM logs'),
        db.query(`
          SELECT severity, count(*)::int AS count 
          FROM logs 
          GROUP BY severity 
          ORDER BY severity
        `),
      ]);

      const severityCounts = {};
      for (const row of severityResult.rows) {
        severityCounts[row.severity] = row.count;
      }

      res.json({
        total: totalResult.rows[0].total,
        severityCounts,
      });
    } catch (err) {
      console.error('Error in GET /api/stats:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
