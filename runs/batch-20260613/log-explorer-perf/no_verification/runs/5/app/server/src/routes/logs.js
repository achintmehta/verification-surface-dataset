import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;

/**
 * GET /api/logs
 * Query params:
 *   offset   integer >= 0          (default 0)
 *   limit    integer 1..200        (default 100)
 *   severity debug|info|warn|error (optional)
 *   q        string                (optional, case-insensitive substring)
 *
 * Returns: { total: number, rows: Row[] }
 */
router.get('/', async (req, res) => {
  try {
    const db = await getDb();

    // --- Parse & validate parameters ---
    let offset = parseInt(req.query.offset ?? '0', 10);
    let limit  = parseInt(req.query.limit  ?? String(DEFAULT_LIMIT), 10);
    const severity = req.query.severity ?? null;
    const q        = req.query.q        ?? null;

    if (!Number.isFinite(offset) || offset < 0) {
      return res.status(400).json({ error: 'offset must be a non-negative integer' });
    }
    if (!Number.isFinite(limit) || limit < 1) {
      return res.status(400).json({ error: 'limit must be a positive integer' });
    }
    if (limit > MAX_LIMIT) {
      return res.status(400).json({ error: `limit must not exceed ${MAX_LIMIT}` });
    }
    if (severity !== null && !VALID_SEVERITIES.has(severity)) {
      return res.status(400).json({
        error: `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}`,
      });
    }

    // --- Build WHERE clause ---
    const conditions = [];
    const params = [];

    if (severity) {
      params.push(severity);
      conditions.push(`severity = $${params.length}`);
    }

    if (q && q.trim() !== '') {
      // Use lower() on both sides; the expression index on lower(message) helps
      params.push(`%${q.toLowerCase().trim()}%`);
      conditions.push(`lower(message) LIKE $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // --- Count query ---
    const countSql = `SELECT COUNT(*) AS cnt FROM logs ${where}`;
    const countResult = await db.query(countSql, params);
    const total = parseInt(countResult.rows[0].cnt, 10);

    // --- Data query ---
    // Append offset and limit as positional params
    const offsetParam = params.length + 1;
    const limitParam  = params.length + 2;
    const dataSql = `
      SELECT id, ts, severity, service, message
      FROM logs
      ${where}
      ORDER BY ts DESC, id DESC
      LIMIT $${limitParam}
      OFFSET $${offsetParam}
    `;
    const dataResult = await db.query(dataSql, [...params, offset, limit]);

    return res.json({ total, rows: dataResult.rows });
  } catch (err) {
    console.error('[GET /api/logs]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
