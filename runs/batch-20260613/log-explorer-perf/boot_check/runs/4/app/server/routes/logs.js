import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

/**
 * GET /api/logs
 * Query params:
 *   offset   - integer >= 0 (default 0)
 *   limit    - integer 1..200 (default 100)
 *   severity - one of debug|info|warn|error (optional)
 *   q        - substring search on message, case-insensitive (optional)
 *
 * Returns: { total: number, rows: Array<{id,ts,severity,service,message}> }
 */
router.get('/logs', async (req, res) => {
  try {
    const db = await getDb();

    // --- Parameter validation ---
    let offset = parseInt(req.query.offset ?? '0', 10);
    let limit  = parseInt(req.query.limit  ?? '100', 10);
    const severity = req.query.severity ?? null;
    const q        = req.query.q        ?? null;

    if (isNaN(offset) || offset < 0) {
      return res.status(400).json({ error: 'offset must be a non-negative integer' });
    }
    if (isNaN(limit) || limit < 1 || limit > MAX_LIMIT) {
      return res.status(400).json({ error: `limit must be between 1 and ${MAX_LIMIT}` });
    }
    if (severity !== null && !VALID_SEVERITIES.has(severity)) {
      return res.status(400).json({ error: `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}` });
    }

    // --- Build WHERE clause ---
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (severity) {
      conditions.push(`severity = $${paramIdx++}`);
      params.push(severity);
    }

    if (q && q.trim().length > 0) {
      // Use lower() for case-insensitive search; works with or without pg_trgm
      conditions.push(`lower(message) LIKE lower($${paramIdx++})`);
      params.push(`%${q.trim()}%`);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    // --- Count query ---
    const countSql = `SELECT COUNT(*) AS cnt FROM logs ${whereClause}`;
    const countResult = await db.query(countSql, params);
    const total = parseInt(countResult.rows[0].cnt, 10);

    // --- Data query ---
    // Add offset and limit params
    const dataParams = [...params, limit, offset];
    const limitParam  = paramIdx++;
    const offsetParam = paramIdx++;

    const dataSql = `
      SELECT id, ts, severity, service, message
      FROM logs
      ${whereClause}
      ORDER BY ts DESC, id DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `;

    const dataResult = await db.query(dataSql, dataParams);

    return res.json({
      total,
      rows: dataResult.rows,
    });
  } catch (err) {
    console.error('[GET /api/logs]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/stats
 * Returns: { total: number, bySeverity: { debug, info, warn, error } }
 */
router.get('/stats', async (req, res) => {
  try {
    const db = await getDb();

    const result = await db.query(`
      SELECT severity, COUNT(*) AS cnt
      FROM logs
      GROUP BY severity
    `);

    const bySeverity = { debug: 0, info: 0, warn: 0, error: 0 };
    let total = 0;

    for (const row of result.rows) {
      const count = parseInt(row.cnt, 10);
      bySeverity[row.severity] = count;
      total += count;
    }

    return res.json({ total, bySeverity });
  } catch (err) {
    console.error('[GET /api/stats]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
