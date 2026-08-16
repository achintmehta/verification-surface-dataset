import { Router } from 'express';

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

export function logsRouter(db) {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      // ── Parse & validate parameters ──────────────────────────────────────
      const rawOffset = req.query.offset !== undefined ? String(req.query.offset) : '0';
      const rawLimit  = req.query.limit  !== undefined ? String(req.query.limit)  : '100';
      const severity  = req.query.severity ? String(req.query.severity) : null;
      const q         = req.query.q        ? String(req.query.q)        : null;

      const offset = parseInt(rawOffset, 10);
      const limit  = parseInt(rawLimit,  10);

      // Validate offset: must be a non-negative integer with no extra chars
      if (isNaN(offset) || offset < 0 || String(offset) !== rawOffset.trim()) {
        return res.status(400).json({ error: 'offset must be a non-negative integer' });
      }
      // Validate limit
      if (isNaN(limit) || limit < 1) {
        return res.status(400).json({ error: 'limit must be a positive integer' });
      }
      if (limit > MAX_LIMIT) {
        return res.status(400).json({ error: `limit must not exceed ${MAX_LIMIT}` });
      }
      // Validate severity
      if (severity !== null && !VALID_SEVERITIES.has(severity)) {
        return res.status(400).json({
          error: `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}`,
        });
      }

      // ── Build WHERE clause ────────────────────────────────────────────────
      const conditions  = [];
      const filterParams = [];

      if (severity) {
        filterParams.push(severity);
        conditions.push(`severity = $${filterParams.length}`);
      }

      if (q && q.trim().length > 0) {
        filterParams.push(`%${q.trim()}%`);
        conditions.push(`message ILIKE $${filterParams.length}`);
      }

      const whereClause = conditions.length > 0
        ? `WHERE ${conditions.join(' AND ')}`
        : '';

      // ── Run count and data queries (PGLite is single-threaded, sequential) ─
      const countSql = `SELECT COUNT(*) AS total FROM logs ${whereClause}`;
      const countResult = await db.query(countSql, filterParams);
      const total = parseInt(countResult.rows[0].total, 10);

      // Append LIMIT and OFFSET as the next positional params
      const limitIdx  = filterParams.length + 1;
      const offsetIdx = filterParams.length + 2;
      const dataParams = [...filterParams, limit, offset];

      const dataSql = `
        SELECT id, ts, severity, service, message
        FROM logs
        ${whereClause}
        ORDER BY ts DESC, id DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
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
