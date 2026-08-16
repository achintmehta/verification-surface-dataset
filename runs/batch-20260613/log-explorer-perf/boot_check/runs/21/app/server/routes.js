const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

export function registerRoutes(app, db) {
  // Cache for stats (corpus is static)
  let statsCache = null;

  // Cache for counts by filter combination (corpus is static)
  const countCache = new Map();

  function countCacheKey(severity, q) {
    return `${severity || ''}|${q || ''}`;
  }

  // GET /api/logs?offset=&limit=&severity=&q=
  app.get('/api/logs', async (req, res) => {
    try {
      const offset = parseInt(req.query.offset ?? '0', 10);
      const limit = parseInt(req.query.limit ?? '50', 10);
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

      // Get total count (use cache since corpus is static)
      const cacheKey = countCacheKey(severity, q);
      let total;
      if (countCache.has(cacheKey)) {
        total = countCache.get(cacheKey);
      } else {
        const countQuery = `SELECT COUNT(*)::int AS total FROM logs ${whereClause}`;
        const countResult = await db.query(countQuery, params);
        total = countResult.rows[0].total;
        countCache.set(cacheKey, total);
      }

      // Get rows
      const dataParams = [...params, limit, offset];
      const dataQuery = `SELECT id, ts, severity, service, message FROM logs ${whereClause} ORDER BY ts DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
      const dataResult = await db.query(dataQuery, dataParams);

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
      if (statsCache) {
        return res.json(statsCache);
      }

      const totalResult = await db.query('SELECT COUNT(*)::int AS total FROM logs');
      const sevResult = await db.query(
        `SELECT severity, COUNT(*)::int AS count FROM logs GROUP BY severity ORDER BY severity`
      );

      const severityCounts = {};
      for (const row of sevResult.rows) {
        severityCounts[row.severity] = row.count;
      }

      statsCache = {
        total: totalResult.rows[0].total,
        severityCounts,
      };

      res.json(statsCache);
    } catch (err) {
      console.error('[api/stats] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
