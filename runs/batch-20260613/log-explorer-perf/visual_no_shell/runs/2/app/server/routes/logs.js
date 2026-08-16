import { Router } from 'express';

export const logsRouter = Router();

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

logsRouter.get('/', async (req, res) => {
  const db = req.db;

  // Parse and validate parameters
  const rawOffset = req.query.offset !== undefined ? req.query.offset : '0';
  const rawLimit  = req.query.limit  !== undefined ? req.query.limit  : '100';
  const severity  = req.query.severity || null;
  const q         = req.query.q || null;

  const offset = parseInt(rawOffset, 10);
  const limit  = parseInt(rawLimit,  10);

  // Validation
  if (isNaN(offset) || offset < 0) {
    return res.status(400).json({ error: 'Invalid offset: must be a non-negative integer' });
  }
  if (isNaN(limit) || limit < 1) {
    return res.status(400).json({ error: 'Invalid limit: must be a positive integer' });
  }
  if (limit > MAX_LIMIT) {
    return res.status(400).json({ error: `Invalid limit: maximum is ${MAX_LIMIT}` });
  }
  if (severity && !VALID_SEVERITIES.has(severity)) {
    return res.status(400).json({ error: `Invalid severity: must be one of ${[...VALID_SEVERITIES].join(', ')}` });
  }

  try {
    // Build WHERE clause
    const conditions = [];
    const params = [];

    if (severity) {
      params.push(severity);
      conditions.push(`severity = $${params.length}`);
    }

    if (q) {
      // Use ILIKE for case-insensitive substring search
      params.push(`%${q}%`);
      conditions.push(`message ILIKE $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM logs ${whereClause}`;
    const countResult = await db.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total, 10);

    // Get rows
    const dataParams = [...params, limit, offset];
    const dataQuery = `
      SELECT id, ts, severity, service, message
      FROM logs
      ${whereClause}
      ORDER BY ts DESC, id DESC
      LIMIT $${dataParams.length - 1}
      OFFSET $${dataParams.length}
    `;

    const dataResult = await db.query(dataQuery, dataParams);

    return res.json({
      total,
      rows: dataResult.rows,
    });
  } catch (err) {
    console.error('Error in GET /api/logs:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
