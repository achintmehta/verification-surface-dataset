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
 *   q       - substring search in message, case-insensitive (optional)
 */
router.get('/logs', async (req, res) => {
  try {
    const db = await getDb();

    // --- Parse & validate params ---
    let offset = parseInt(req.query.offset ?? '0', 10);
    let limit = parseInt(req.query.limit ?? '100', 10);
    const severity = req.query.severity ?? '';
    const q = req.query.q ?? '';

    if (isNaN(offset) || offset < 0) {
      return res.status(400).json({ error: 'offset must be a non-negative integer' });
    }
    if (isNaN(limit) || limit < 1 || limit > MAX_LIMIT) {
      return res.status(400).json({ error: `limit must be between 1 and ${MAX_LIMIT}` });
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
      params.push(`%${q}%`);
      conditions.push(`message ILIKE $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

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
 * Returns total row count and per-severity counts.
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
