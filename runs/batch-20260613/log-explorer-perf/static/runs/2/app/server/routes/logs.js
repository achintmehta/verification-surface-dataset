/**
 * GET /api/logs
 * Query params:
 *   offset   integer >= 0          (default 0)
 *   limit    integer 1..200        (default 100)
 *   severity debug|info|warn|error (optional)
 *   q        string                (optional, case-insensitive substring)
 *
 * Returns: { total: number, rows: Array<{id,ts,severity,service,message}> }
 */

import express from 'express';

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

export function logsRouter(db) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const { offset: rawOffset, limit: rawLimit, severity, q } = req.query;

      // --- Parameter validation ---
      const offset = rawOffset !== undefined ? parseInt(rawOffset, 10) : 0;
      const limit  = rawLimit  !== undefined ? parseInt(rawLimit,  10) : 100;

      if (!Number.isInteger(offset) || isNaN(offset) || offset < 0) {
        return res.status(400).json({ error: 'offset must be a non-negative integer' });
      }
      if (!Number.isInteger(limit) || isNaN(limit) || limit < 1 || limit > MAX_LIMIT) {
        return res.status(400).json({ error: `limit must be an integer between 1 and ${MAX_LIMIT}` });
      }
      if (severity !== undefined && severity !== '' && !VALID_SEVERITIES.has(severity)) {
        return res.status(400).json({ error: `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}` });
      }

      // --- Build WHERE clause ---
      const conditions = [];
      const params = [];

      if (severity && severity !== '') {
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
      // Use OFFSET/LIMIT — PGLite with indexes on (severity, ts DESC) and ts DESC
      // makes this fast enough for the stated budgets.
      params.push(limit);
      params.push(offset);
      const dataSql = `
        SELECT id, ts, severity, service, message
        FROM logs
        ${where}
        ORDER BY ts DESC
        LIMIT $${params.length - 1}
        OFFSET $${params.length}
      `;
      const dataResult = await db.query(dataSql, params);

      return res.json({ total, rows: dataResult.rows });
    } catch (err) {
      console.error('[GET /api/logs] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
