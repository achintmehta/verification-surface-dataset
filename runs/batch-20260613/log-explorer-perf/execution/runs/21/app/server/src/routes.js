const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

export function setupRoutes(app, db) {

  app.get('/api/logs', async (req, res) => {
    try {
      let { offset, limit, severity, q } = req.query;

      // Parse and validate offset
      offset = offset !== undefined ? parseInt(offset, 10) : 0;
      if (isNaN(offset) || offset < 0) {
        return res.status(400).json({ error: 'offset must be a non-negative integer' });
      }

      // Parse and validate limit
      limit = limit !== undefined ? parseInt(limit, 10) : 50;
      if (isNaN(limit) || limit < 1) {
        return res.status(400).json({ error: 'limit must be a positive integer' });
      }
      if (limit > MAX_LIMIT) {
        return res.status(400).json({ error: `limit must not exceed ${MAX_LIMIT}` });
      }

      // Validate severity
      if (severity !== undefined && severity !== '') {
        if (!VALID_SEVERITIES.has(severity)) {
          return res.status(400).json({ error: `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}` });
        }
      } else {
        severity = null;
      }

      // Sanitize q
      if (q !== undefined && q.trim() === '') {
        q = null;
      } else if (q === undefined) {
        q = null;
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
        conditions.push(`message ILIKE $${paramIdx}`);
        params.push(`%${q}%`);
        paramIdx++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Get total count
      const countSql = `SELECT COUNT(*)::int AS total FROM logs ${whereClause}`;
      const countResult = await db.query(countSql, params);
      const total = countResult.rows[0].total;

      // Get rows
      const rowsSql = `SELECT id, ts, severity, service, message FROM logs ${whereClause} ORDER BY ts DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
      const rowParams = [...params, limit, offset];
      const rowsResult = await db.query(rowsSql, rowParams);

      res.json({
        total,
        rows: rowsResult.rows
      });

    } catch (err) {
      console.error('Error in /api/logs:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/stats', async (_req, res) => {
    try {
      const totalResult = await db.query('SELECT COUNT(*)::int AS total FROM logs');
      const severityResult = await db.query(`
        SELECT severity, COUNT(*)::int AS count 
        FROM logs 
        GROUP BY severity 
        ORDER BY severity
      `);

      const bySeverity = {};
      for (const row of severityResult.rows) {
        bySeverity[row.severity] = row.count;
      }

      res.json({
        total: totalResult.rows[0].total,
        bySeverity
      });
    } catch (err) {
      console.error('Error in /api/stats:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
