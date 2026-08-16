import { Router } from 'express';

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;

export function createLogsRouter(db) {
  const router = Router();

  /**
   * GET /api/logs
   * Query params:
   *   offset   - integer >= 0 (default 0)
   *   limit    - integer 1..200 (default 100)
   *   severity - one of debug|info|warn|error (optional)
   *   q        - substring to match in message, case-insensitive (optional)
   *
   * Returns: { total: number, rows: Array<{id,ts,severity,service,message}> }
   */
  router.get('/', async (req, res) => {
    try {
      const { offset: rawOffset, limit: rawLimit, severity, q } = req.query;

      // --- Parameter validation ---
      const offset = rawOffset !== undefined ? parseInt(rawOffset, 10) : 0;
      const limit  = rawLimit  !== undefined ? parseInt(rawLimit,  10) : DEFAULT_LIMIT;

      if (!Number.isInteger(offset) || isNaN(offset) || offset < 0) {
        return res.status(400).json({ error: 'offset must be a non-negative integer' });
      }
      if (!Number.isInteger(limit) || isNaN(limit) || limit < 1 || limit > MAX_LIMIT) {
        return res.status(400).json({ error: `limit must be an integer between 1 and ${MAX_LIMIT}` });
      }
      if (severity !== undefined && !VALID_SEVERITIES.has(severity)) {
        return res.status(400).json({ error: `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}` });
      }

      // --- Build WHERE clause ---
      const conditions = [];
      const params = [];

      if (severity) {
        params.push(severity);
        conditions.push(`severity = $${params.length}`);
      }

      if (q && q.trim() !== '') {
        params.push(`%${q.trim()}%`);
        conditions.push(`message ILIKE $${params.length}`);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // --- Count query ---
      const countSql = `SELECT COUNT(*) AS total FROM logs ${where}`;
      const countResult = await db.query(countSql, params);
      const total = parseInt(countResult.rows[0].total, 10);

      // --- Data query ---
      // Append limit and offset after the filter params
      const limitIdx  = params.length + 1;
      const offsetIdx = params.length + 2;
      const dataParams = [...params, limit, offset];
      const dataSql = `
        SELECT id, ts, severity, service, message
        FROM logs
        ${where}
        ORDER BY ts DESC, id DESC
        LIMIT $${limitIdx}
        OFFSET $${offsetIdx}
      `;

      const dataResult = await db.query(dataSql, dataParams);

      return res.json({
        total,
        rows: dataResult.rows,
      });
    } catch (err) {
      console.error('[logs] Query error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
