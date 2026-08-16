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

      if (isNaN(offset) || !Number.isInteger(offset) || offset < 0) {
        return res.status(400).json({ error: 'offset must be a non-negative integer' });
      }
      if (isNaN(limit) || !Number.isInteger(limit) || limit < 1) {
        return res.status(400).json({ error: 'limit must be a positive integer' });
      }
      if (limit > MAX_LIMIT) {
        return res.status(400).json({ error: `limit must not exceed ${MAX_LIMIT}` });
      }
      if (severity !== undefined && !VALID_SEVERITIES.has(severity)) {
        return res.status(400).json({
          error: `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}`,
        });
      }

      // --- Build parameterized WHERE clause ---
      const params = [];
      const conditions = [];

      if (severity) {
        params.push(severity);
        conditions.push(`severity = $${params.length}`);
      }

      if (q && q.trim()) {
        // ILIKE with % wildcards — supported by the GIN trigram index
        params.push(`%${q.trim()}%`);
        conditions.push(`message ILIKE $${params.length}`);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // --- Count query (same params) ---
      const countSql = `SELECT COUNT(*) AS total FROM logs ${where}`;
      const countResult = await db.query(countSql, params);
      const total = parseInt(countResult.rows[0].total, 10);

      // --- Data query (append limit/offset params) ---
      const dataParams = [...params, limit, offset];
      // limitIdx is the 1-based position of `limit` in dataParams
      const limitIdx  = dataParams.length - 1;  // second-to-last
      const offsetIdx = dataParams.length;       // last

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
      console.error('[/api/logs] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
