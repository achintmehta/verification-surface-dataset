import { Router } from 'express';

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;

export function logsRouter(db) {
  const router = Router();

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
        return res.status(400).json({ error: `limit must be between 1 and ${MAX_LIMIT}` });
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

      if (q && q.trim()) {
        // Use lower() on both sides so the functional index idx_logs_message_lower
        // can be used by the planner; wrap in % for substring match
        params.push(`%${q.trim().toLowerCase()}%`);
        conditions.push(`lower(message) LIKE $${params.length}`);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // --- Count query ---
      const countSql = `SELECT COUNT(*) AS total FROM logs ${where}`;
      const countResult = await db.query(countSql, params);
      const total = parseInt(countResult.rows[0].total, 10);

      // --- Data query ---
      // Add offset and limit as positional params
      const offsetParam = params.length + 1;
      const limitParam  = params.length + 2;

      const dataSql = `
        SELECT id, ts, severity, service, message
        FROM logs
        ${where}
        ORDER BY ts DESC, id DESC
        OFFSET $${offsetParam}
        LIMIT  $${limitParam}
      `;

      const dataResult = await db.query(dataSql, [...params, offset, limit]);

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
