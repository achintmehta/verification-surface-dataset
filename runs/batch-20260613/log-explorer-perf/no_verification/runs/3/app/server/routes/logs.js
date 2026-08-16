/**
 * GET /api/logs
 *
 * Query params:
 *   offset   – integer >= 0 (default 0)
 *   limit    – integer 1-200 (default 100)
 *   severity – one of debug|info|warn|error (optional)
 *   q        – message substring, case-insensitive (optional)
 *
 * Returns: { total: number, rows: Array<{id,ts,severity,service,message}> }
 *
 * Performance strategy:
 *   - All filtering and slicing happens in PGLite (Postgres).
 *   - For unfiltered queries the idx_logs_ts index is used.
 *   - For severity-only queries idx_logs_severity_ts is used.
 *   - For substring queries the GIN trgm index accelerates ILIKE.
 *   - We run COUNT and SELECT concurrently (Promise.all) to minimize latency.
 */

import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

router.get('/', async (req, res) => {
  try {
    const db = await getDb();

    // ── Parameter validation ───────────────────────────────────────────────
    const offsetRaw   = req.query.offset   ?? '0';
    const limitRaw    = req.query.limit    ?? '100';
    const severityRaw = req.query.severity ?? null;
    const qRaw        = req.query.q        ?? null;

    const offset = parseInt(offsetRaw, 10);
    const limit  = parseInt(limitRaw,  10);

    if (isNaN(offset) || offset < 0) {
      return res.status(400).json({ error: 'offset must be a non-negative integer' });
    }
    if (isNaN(limit) || limit < 1 || limit > MAX_LIMIT) {
      return res.status(400).json({ error: `limit must be between 1 and ${MAX_LIMIT}` });
    }
    if (severityRaw !== null && !VALID_SEVERITIES.has(severityRaw)) {
      return res.status(400).json({ error: `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}` });
    }

    const severity = severityRaw || null;
    const q        = (qRaw && qRaw.trim()) ? qRaw.trim() : null;

    // ── Build WHERE clause (shared between COUNT and SELECT) ───────────────
    // filterParams are the bind values for the WHERE conditions only.
    const filterParams = [];
    const conditions   = [];

    if (severity) {
      filterParams.push(severity);
      conditions.push(`severity = $${filterParams.length}`);
    }
    if (q) {
      filterParams.push(`%${q}%`);
      conditions.push(`message ILIKE $${filterParams.length}`);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    // ── COUNT query ────────────────────────────────────────────────────────
    const countSql = `SELECT COUNT(*) AS n FROM logs ${whereClause}`;

    // ── SELECT query ───────────────────────────────────────────────────────
    // Append limit and offset after the filter params.
    const rowParams = [...filterParams, limit, offset];
    const limitPlaceholder  = `$${filterParams.length + 1}`;
    const offsetPlaceholder = `$${filterParams.length + 2}`;

    const rowSql = `
      SELECT id, ts, severity, service, message
      FROM logs
      ${whereClause}
      ORDER BY ts DESC
      LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
    `;

    // ── Execute concurrently ───────────────────────────────────────────────
    const [countResult, rowResult] = await Promise.all([
      db.query(countSql, filterParams),
      db.query(rowSql,   rowParams),
    ]);

    const total = parseInt(countResult.rows[0].n, 10);
    const rows  = rowResult.rows;

    res.json({ total, rows });
  } catch (err) {
    console.error('[GET /api/logs]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
