import { Router } from 'express';

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

export function logsRouter(db) {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const { offset: rawOffset, limit: rawLimit, severity, q } = req.query;

      // --- Parameter validation ---
      const offset = rawOffset !== undefined ? parseInt(rawOffset, 10) : 0;
      const limit  = rawLimit  !== undefined ? parseInt(rawLimit,  10) : 100;

      if (!Number.isInteger(offset) || isNaN(offset) || offset < 0) {
        return res.status(400).json({ error: 'offset must be a non-negative integer' });
      }
      if (!Number.isInteger(limit) || isNaN(limit) || limit < 1) {
        return res.status(400).json({ error: 'limit must be a positive integer' });
      }
      if (limit > MAX_LIMIT) {
        return res.status(400).json({ error: `limit must not exceed ${MAX_LIMIT}` });
      }
      if (severity !== undefined && !VALID_SEVERITIES.has(severity)) {
        return res.status(400).json({ error: `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}` });
      }

      // --- Build query ---
      const conditions = [];
      const params = [];

      if (severity) {
        params.push(severity);
        conditions.push(`severity = $${params.length}`);
      }

      if (q && q.trim()) {
        params.push(`%${q.trim()}%`);
        conditions.push(`message ILIKE $${params.length}`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Count query
      const countSql = `SELECT COUNT(*) AS total FROM logs ${whereClause}`;
      const countResult = await db.query(countSql, params);
      const total = parseInt(countResult.rows[0].total, 10);

      // Data query — ordered by ts DESC, then id DESC for stable tie-breaking
      const dataSql = `
        SELECT id, ts, severity, service, message
        FROM logs
        ${whereClause}
        ORDER BY ts DESC, id DESC
        LIMIT $${params.length + 1}
        OFFSET $${params.length + 2}
      `;
      const dataResult = await db.query(dataSql, [...params, limit, offset]);

      return res.json({
        total,
        rows: dataResult.rows,
      });
    } catch (err) {
      console.error('[/api/logs] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
