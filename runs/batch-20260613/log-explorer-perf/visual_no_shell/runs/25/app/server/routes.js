const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

function registerRoutes(app, db) {

  // GET /api/logs?offset=&limit=&severity=&q=
  app.get('/api/logs', async (req, res) => {
    try {
      // Parse and validate parameters
      let offset = parseInt(req.query.offset, 10);
      let limit = parseInt(req.query.limit, 10);
      const severity = req.query.severity || null;
      const q = req.query.q || null;

      // Defaults
      if (isNaN(offset)) offset = 0;
      if (isNaN(limit)) limit = 100;

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

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Get total count
      const countQuery = `SELECT COUNT(*)::int AS total FROM logs ${whereClause}`;
      const countResult = await db.query(countQuery, params);
      const total = countResult.rows[0].total;

      // Get rows
      const dataParams = [...params, limit, offset];
      const dataQuery = `SELECT id, ts, severity, service, message FROM logs ${whereClause} ORDER BY ts DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
      const dataResult = await db.query(dataQuery, dataParams);

      res.json({
        total,
        rows: dataResult.rows
      });
    } catch (err) {
      console.error('[api/logs] Error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/stats
  app.get('/api/stats', async (req, res) => {
    try {
      const totalResult = await db.query('SELECT COUNT(*)::int AS total FROM logs');
      const severityResult = await db.query(
        `SELECT severity, COUNT(*)::int AS count FROM logs GROUP BY severity ORDER BY severity`
      );

      const severityCounts = {};
      for (const row of severityResult.rows) {
        severityCounts[row.severity] = row.count;
      }

      res.json({
        total: totalResult.rows[0].total,
        severityCounts
      });
    } catch (err) {
      console.error('[api/stats] Error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}

module.exports = { registerRoutes };
