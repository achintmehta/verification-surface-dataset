import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

/**
 * GET /api/logs
 * Query params:
 *   offset   integer >= 0          (default 0)
 *   limit    integer 1..200        (default 100)
 *   severity debug|info|warn|error (optional)
 *   q        string                (optional, case-insensitive substring)
 *
 * Returns: { total: number, rows: LogRow[] }
 *
 * Query strategy:
 *   - No filter:       uses idx_logs_ts_covering (index-only scan, no heap fetches)
 *   - Severity filter: uses idx_logs_severity_ts (index scan on severity+ts)
 *   - Message filter:  uses idx_logs_message_trgm (GIN trigram) + sort
 *   - Combined:        planner chooses best path
 */
router.get('/logs', async (req, res) => {
  try {
    const db = await getDb();

    // --- Parse & validate parameters ---
    const rawOffset = req.query.offset ?? '0';
    const rawLimit = req.query.limit ?? '100';
    const severity = req.query.severity ?? '';
    const q = req.query.q ?? '';

    const offset = parseInt(rawOffset, 10);
    const limit = parseInt(rawLimit, 10);

    if (!Number.isInteger(offset) || isNaN(offset) || offset < 0) {
      return res.status(400).json({ error: 'offset must be a non-negative integer' });
    }
    if (!Number.isInteger(limit) || isNaN(limit) || limit < 1) {
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
      conditions.push(`message ILIKE '%' || $${params.length} || '%'`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // --- Count query ---
    // Run count and data queries. For the count, we use a lightweight query.
    const countSql = `SELECT COUNT(*) AS cnt FROM logs ${where}`;
    const countResult = await db.query(countSql, params);
    const total = parseInt(countResult.rows[0].cnt, 10);

    // --- Data query ---
    // ORDER BY ts DESC only (no secondary sort) so the planner can use
    // idx_logs_ts_covering (no filter) or idx_logs_severity_ts (severity filter)
    // without needing an extra sort step.
    const dataParams = [...params, limit, offset];
    const dataSql = `
      SELECT id, ts, severity, service, message
      FROM logs
      ${where}
      ORDER BY ts DESC
      LIMIT $${dataParams.length - 1}
      OFFSET $${dataParams.length}
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
