import { Router } from 'express';
import { getDb } from './db.js';

const router = Router();

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

/**
 * GET /api/logs
 * Query params:
 *   offset   integer >= 0, default 0
 *   limit    integer 1–200, default 100
 *   severity debug|info|warn|error (optional)
 *   q        case-insensitive message substring (optional)
 *
 * Returns: { total: number, rows: Array<{id, ts, severity, service, message}> }
 */
router.get('/logs', async (req, res) => {
  try {
    const { offset: rawOffset, limit: rawLimit, severity, q } = req.query;

    // ── Validate offset ──────────────────────────────────────────────────────
    const offset = rawOffset !== undefined ? parseInt(rawOffset, 10) : 0;
    if (isNaN(offset) || !Number.isInteger(offset) || offset < 0) {
      return res.status(400).json({ error: 'offset must be a non-negative integer' });
    }

    // ── Validate limit ───────────────────────────────────────────────────────
    const limit = rawLimit !== undefined ? parseInt(rawLimit, 10) : 100;
    if (isNaN(limit) || !Number.isInteger(limit) || limit < 1) {
      return res.status(400).json({ error: 'limit must be a positive integer' });
    }
    if (limit > MAX_LIMIT) {
      return res.status(400).json({ error: `limit must not exceed ${MAX_LIMIT}` });
    }

    // ── Validate severity ────────────────────────────────────────────────────
    if (severity !== undefined && severity !== '' && !VALID_SEVERITIES.has(severity)) {
      return res.status(400).json({
        error: `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}`,
      });
    }

    const db = getDb();

    // ── Build WHERE clause ───────────────────────────────────────────────────
    const conditions = [];
    const params     = [];

    if (severity && VALID_SEVERITIES.has(severity)) {
      params.push(severity);
      conditions.push(`severity = $${params.length}`);
    }

    const qTrimmed = q ? q.trim() : '';
    if (qTrimmed) {
      // Wrap with wildcards for ILIKE substring match
      params.push(`%${qTrimmed}%`);
      conditions.push(`message ILIKE $${params.length}`);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    // ── Count query ──────────────────────────────────────────────────────────
    const countResult = await db.query(
      `SELECT COUNT(*) AS total FROM logs ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].total, 10);

    // ── Data query ───────────────────────────────────────────────────────────
    const dataParams = [...params, limit, offset];
    const dataResult = await db.query(
      `SELECT id, ts, severity, service, message
       FROM   logs
       ${whereClause}
       ORDER  BY ts DESC, id DESC
       LIMIT  $${dataParams.length - 1}
       OFFSET $${dataParams.length}`,
      dataParams
    );

    return res.json({ total, rows: dataResult.rows });
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
    const db = getDb();

    const result = await db.query(`
      SELECT severity, COUNT(*) AS cnt
      FROM   logs
      GROUP  BY severity
    `);

    const bySeverity = { debug: 0, info: 0, warn: 0, error: 0 };
    let total = 0;
    for (const row of result.rows) {
      const cnt = parseInt(row.cnt, 10);
      bySeverity[row.severity] = cnt;
      total += cnt;
    }

    return res.json({ total, bySeverity });
  } catch (err) {
    console.error('[GET /api/stats]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
