import { Router } from 'express';

const VALID_SEVERITIES = ['debug', 'info', 'warn', 'error'];
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * Escape special LIKE pattern characters so user input is treated literally.
 */
function escapeLike(str) {
  return str.replace(/[%_\\]/g, '\\$&');
}

export function createRouter(db) {
  const router = Router();

  // ── Count cache ───────────────────────────────────────────────────────────
  // The corpus is static after seeding, so COUNT results never change.
  // Key: JSON-serialized filter params → total count.
  const countCache = new Map();

  function countCacheKey(severity, q) {
    return JSON.stringify([severity || '', q || '']);
  }

  /**
   * GET /api/logs
   * Query params: offset, limit, severity, q
   * Returns: { total, rows }
   */
  router.get('/logs', async (req, res) => {
    try {
      // Parse and validate parameters
      let offset = parseInt(req.query.offset, 10);
      let limit = parseInt(req.query.limit, 10);
      const severity = req.query.severity || null;
      const q = req.query.q || null;

      // Default values
      if (isNaN(offset)) offset = 0;
      if (isNaN(limit)) limit = DEFAULT_LIMIT;

      // Validation
      if (offset < 0) {
        return res.status(400).json({ error: 'offset must be non-negative' });
      }
      if (limit < 1 || limit > MAX_LIMIT) {
        return res.status(400).json({ error: `limit must be between 1 and ${MAX_LIMIT}` });
      }
      if (severity && !VALID_SEVERITIES.includes(severity)) {
        return res.status(400).json({ error: `severity must be one of: ${VALID_SEVERITIES.join(', ')}` });
      }

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
        params.push(`%${escapeLike(q)}%`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Get total count (cached for static corpus)
      const cKey = countCacheKey(severity, q);
      let total;
      if (countCache.has(cKey)) {
        total = countCache.get(cKey);
      } else {
        const countSql = `SELECT COUNT(*)::int AS total FROM logs ${whereClause}`;
        const countResult = await db.query(countSql, params);
        total = countResult.rows[0].total;
        countCache.set(cKey, total);
      }

      // Get rows — always a fresh query (different offsets)
      const dataSql = `SELECT id, ts, severity, service, message FROM logs ${whereClause} ORDER BY ts DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
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
   * Returns: { total, severities: { debug, info, warn, error } }
   * Cached because the corpus is static after seeding.
   */
  let cachedStats = null;

  router.get('/stats', async (_req, res) => {
    try {
      if (cachedStats) return res.json(cachedStats);

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
      cachedStats = {
        total: row.total,
        severities: {
          debug: row.debug,
          info: row.info,
          warn: row.warn,
          error: row.error,
        },
      };
      return res.json(cachedStats);
    } catch (err) {
      console.error('Error in GET /api/stats:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
