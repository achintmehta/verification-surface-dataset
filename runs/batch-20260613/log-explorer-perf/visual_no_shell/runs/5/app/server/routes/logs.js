import { Router } from 'express';

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

export function createLogsRouter(db) {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      // Parse and validate parameters
      const rawOffset = req.query.offset !== undefined ? req.query.offset : '0';
      const rawLimit  = req.query.limit  !== undefined ? req.query.limit  : '100';
      const severity  = req.query.severity || null;
      const q         = req.query.q        || null;

      const offset = parseInt(rawOffset, 10);
      const limit  = parseInt(rawLimit,  10);

      // Validation
      if (!Number.isInteger(offset) || isNaN(offset) || offset < 0) {
        return res.status(400).json({ error: 'offset must be a non-negative integer' });
      }
      if (!Number.isInteger(limit) || isNaN(limit) || limit < 1) {
        return res.status(400).json({ error: 'limit must be a positive integer' });
      }
      if (limit > MAX_LIMIT) {
        return res.status(400).json({ error: `limit must not exceed ${MAX_LIMIT}` });
      }
      if (severity !== null && !VALID_SEVERITIES.has(severity)) {
        return res.status(400).json({ error: `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}` });
      }

      // Build WHERE clause
      const conditions = [];
      const params = [];

      if (severity) {
        params.push(severity);
        conditions.push(`severity = $${params.length}`);
      }

      if (q) {
        params.push(`%${q}%`);
        conditions.push(`message ILIKE $${params.length}`);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Count query
      const countSql = `SELECT COUNT(*) AS total FROM logs ${where}`;
      const countResult = await db.query(countSql, params);
      const total = parseInt(countResult.rows[0].total, 10);

      // Data query with OFFSET/LIMIT
      // For deep offsets with severity filter, the index on (severity, ts DESC) helps.
      // For substring search, we rely on the ts index for ordering.
      const offsetParam = params.length + 1;
      const limitParam  = params.length + 2;

      const dataSql = `
        SELECT id, ts, severity, service, message
        FROM logs
        ${where}
        ORDER BY ts DESC, id DESC
        OFFSET $${offsetParam}
        LIMIT $${limitParam}
      `;

      const dataResult = await db.query(dataSql, [...params, offset, limit]);

      return res.json({
        total,
        rows: dataResult.rows,
      });
    } catch (err) {
      console.error('Error in GET /api/logs:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
