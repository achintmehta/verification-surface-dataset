import { Router } from 'express';

export const logsRouter = Router();

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

logsRouter.get('/', async (req, res) => {
  try {
    const { offset: rawOffset, limit: rawLimit, severity, q } = req.query;

    // Parse and validate parameters
    const offset = rawOffset !== undefined ? parseInt(rawOffset, 10) : 0;
    const limit = rawLimit !== undefined ? parseInt(rawLimit, 10) : 100;

    if (!Number.isInteger(offset) || isNaN(offset) || offset < 0) {
      return res.status(400).json({ error: 'Invalid offset: must be a non-negative integer' });
    }
    if (!Number.isInteger(limit) || isNaN(limit) || limit < 1 || limit > MAX_LIMIT) {
      return res.status(400).json({ error: `Invalid limit: must be between 1 and ${MAX_LIMIT}` });
    }
    if (severity !== undefined && !VALID_SEVERITIES.has(severity)) {
      return res.status(400).json({ error: `Invalid severity: must be one of ${[...VALID_SEVERITIES].join(', ')}` });
    }

    const db = req.db;
    const params = [];
    const conditions = [];
    let paramIdx = 1;

    if (severity) {
      conditions.push(`severity = $${paramIdx++}`);
      params.push(severity);
    }

    if (q && q.trim()) {
      // Case-insensitive substring match using ILIKE
      conditions.push(`message ILIKE $${paramIdx++}`);
      params.push(`%${q.trim()}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count for this filter combination
    const countSql = `SELECT COUNT(*) AS total FROM logs ${whereClause}`;
    const countResult = await db.query(countSql, params);
    const total = parseInt(countResult.rows[0].total, 10);

    // Get the windowed rows
    const rowsSql = `
      SELECT id, ts, severity, service, message
      FROM logs
      ${whereClause}
      ORDER BY ts DESC, id DESC
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    const rowsParams = [...params, limit, offset];
    const rowsResult = await db.query(rowsSql, rowsParams);

    return res.json({
      total,
      rows: rowsResult.rows,
    });
  } catch (err) {
    console.error('[logs] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
