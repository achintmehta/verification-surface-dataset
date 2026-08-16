import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

/**
 * GET /api/logs
 * Query params:
 *   offset  - integer >= 0 (default 0)
 *   limit   - integer 1..200 (default 100)
 *   severity - one of debug|info|warn|error (optional)
 *   q       - substring search on message, case-insensitive (optional)
 *
 * Returns: { total: number, rows: Array<{id, ts, severity, service, message}> }
 */
router.get('/logs', async (req, res) => {
  try {
    const db = getDb();

    // --- Parameter validation ---
    let offset = parseInt(req.query.offset ?? '0', 10);
    let limit = parseInt(req.query.limit ?? '100', 10);
    const severity = req.query.severity ?? '';
    const q = req.query.q ?? '';

    if (isNaN(offset) || offset < 0) {
      return res.status(400).json({ error: 'offset must be a non-negative integer' });
    }
    if (isNaN(limit) || limit < 1) {
      return res.status(400).json({ error: 'limit must be a positive integer' });
    }
    if (limit > MAX_LIMIT) {
      return res.status(400).json({ error: `limit must not exceed ${MAX_LIMIT}` });
    }
    if (severity && !VALID_SEVERITIES.has(severity)) {
      return res.status(400).json({ error: `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}` });
    }

    // --- Build WHERE clause ---
    const conditions = [];
    const params = [];

    if (severity) {
      params.push(severity);
      conditions.push(`severity = $${params.length}`);
    }

    if (q) {
      params.push(q);
      // Use ILIKE with trigram index for fast substring search
      conditions.push(`message ILIKE $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // For ILIKE we need the % wildcards in the value
    // Adjust the q param to include wildcards
    if (q) {
      params[params.length - 1] = `%${q}%`;
    }

    // --- Count query ---
    const countSql = `SELECT COUNT(*) AS cnt FROM logs ${where}`;
    const countResult = await db.query(countSql, params);
    const total = parseInt(countResult.rows[0].cnt, 10);

    // --- Data query ---
    const dataParams = [...params, limit, offset];
    const dataSql = `
      SELECT id, ts, severity, service, message
      FROM logs
      ${where}
      ORDER BY ts DESC, id DESC
      LIMIT $${dataParams.length - 1}
      OFFSET $${dataParams.length}
    `;

    const dataResult = await db.query(dataSql, dataParams);

    return res.json({
      total,
      rows: dataResult.rows,
    });
  } catch (err) {
    console.error('[/api/logs]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/stats
 * Returns: { total: number, bySeverity: { debug, info, warn, error } }
 */
router.get('/stats', async (req, res) => {
  try {
    const db = getDb();

    const result = await db.query(`
      SELECT severity, COUNT(*) AS cnt
      FROM logs
      GROUP BY severity
    `);

    const bySeverity = { debug: 0, info: 0, warn: 0, error: 0 };
    let total = 0;
    for (const row of result.rows) {
      bySeverity[row.severity] = parseInt(row.cnt, 10);
      total += parseInt(row.cnt, 10);
    }

    return res.json({ total, bySeverity });
  } catch (err) {
    console.error('[/api/stats]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
