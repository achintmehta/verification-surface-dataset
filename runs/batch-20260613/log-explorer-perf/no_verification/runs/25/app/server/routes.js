import { Router } from 'express';

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

// Escape special ILIKE characters
function escapeIlike(str) {
  return str.replace(/[%_\\]/g, '\\$&');
}

export function createRouter(db) {
  const router = Router();

  // Simple LRU-ish count cache to avoid re-running COUNT(*) for the same filters.
  // Since the corpus is static, counts never change.
  const countCache = new Map();
  const COUNT_CACHE_MAX = 500;

  async function getCount(whereClause, params) {
    const key = `${whereClause}::${JSON.stringify(params)}`;
    if (countCache.has(key)) {
      return countCache.get(key);
    }
    const countSql = `SELECT COUNT(*) as total FROM logs ${whereClause}`;
    const countResult = await db.query(countSql, params);
    const total = parseInt(countResult.rows[0].total);
    
    // Evict oldest if too large
    if (countCache.size >= COUNT_CACHE_MAX) {
      const firstKey = countCache.keys().next().value;
      countCache.delete(firstKey);
    }
    countCache.set(key, total);
    return total;
  }

  // GET /api/logs?offset=&limit=&severity=&q=
  router.get('/api/logs', async (req, res) => {
    try {
      // Parse and validate parameters
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
        conditions.push(`severity = $${paramIdx}`);
        params.push(severity);
        paramIdx++;
      }

      if (q) {
        conditions.push(`message ILIKE $${paramIdx}`);
        params.push(`%${escapeIlike(q)}%`);
        paramIdx++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Get total count (cached since corpus is static)
      const total = await getCount(whereClause, params);

      // Get rows with offset/limit
      const dataSql = `SELECT id, ts, severity, service, message FROM logs ${whereClause} ORDER BY ts DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
      const dataParams = [...params, limit, offset];
      const dataResult = await db.query(dataSql, dataParams);

      res.json({
        total,
        rows: dataResult.rows
      });
    } catch (err) {
      console.error('Error in /api/logs:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/stats
  router.get('/api/stats', async (req, res) => {
    try {
      const totalResult = await db.query('SELECT COUNT(*) as total FROM logs');
      const severityResult = await db.query(
        `SELECT severity, COUNT(*) as count FROM logs GROUP BY severity ORDER BY severity`
      );

      const severityCounts = {};
      for (const row of severityResult.rows) {
        severityCounts[row.severity] = parseInt(row.count);
      }

      res.json({
        total: parseInt(totalResult.rows[0].total),
        severities: severityCounts
      });
    } catch (err) {
      console.error('Error in /api/stats:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
