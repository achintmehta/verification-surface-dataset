const express = require('express');
const { getDb } = require('./db');

const router = express.Router();

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

// ── Simple server-side cache for counts ──────────────────────────────────
// Since the corpus is static after seeding, counts never change.
const countCache = new Map();

async function getCachedCount(db, whereClause, params) {
  const key = `${whereClause}|${JSON.stringify(params)}`;
  if (countCache.has(key)) return countCache.get(key);

  const countSql = `SELECT COUNT(*)::int AS total FROM logs ${whereClause}`;
  const countResult = await db.query(countSql, params);
  const total = countResult.rows[0].total;
  countCache.set(key, total);
  return total;
}

// ── Cached stats ─────────────────────────────────────────────────────────
let cachedStats = null;

router.get('/logs', async (req, res) => {
  try {
    // Parse and validate parameters
    let offset = parseInt(req.query.offset, 10);
    let limit = parseInt(req.query.limit, 10);
    const severity = req.query.severity || null;
    const q = req.query.q || null;

    // Default values
    if (isNaN(offset)) offset = 0;
    if (isNaN(limit)) limit = DEFAULT_LIMIT;

    // Validation
    if (offset < 0) {
      return res.status(400).json({ error: 'offset must be non-negative' });
    }
    if (limit < 1 || limit > MAX_LIMIT) {
      return res.status(400).json({ error: `limit must be between 1 and ${MAX_LIMIT}` });
    }
    if (severity && !VALID_SEVERITIES.has(severity)) {
      return res.status(400).json({ error: `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}` });
    }

    const db = await getDb();

    // Build WHERE clause
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (severity) {
      conditions.push(`severity = $${paramIdx}`);
      params.push(severity);
      paramIdx++;
    }
    if (q) {
      conditions.push(`message ILIKE $${paramIdx}`);
      params.push(`%${q}%`);
      paramIdx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count (cached since corpus is static)
    const total = await getCachedCount(db, whereClause, params);

    // Get windowed rows
    const dataSql = `SELECT id, ts, severity, service, message FROM logs ${whereClause} ORDER BY ts DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
    const dataParams = [...params, limit, offset];
    const dataResult = await db.query(dataSql, dataParams);

    res.json({
      total,
      rows: dataResult.rows,
    });
  } catch (err) {
    console.error('Error in /api/logs:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/stats', async (req, res) => {
  try {
    if (cachedStats) {
      return res.json(cachedStats);
    }

    const db = await getDb();

    const result = await db.query(`
      SELECT 
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE severity = 'debug')::int AS debug,
        COUNT(*) FILTER (WHERE severity = 'info')::int AS info,
        COUNT(*) FILTER (WHERE severity = 'warn')::int AS warn,
        COUNT(*) FILTER (WHERE severity = 'error')::int AS error
      FROM logs
    `);

    const row = result.rows[0];
    cachedStats = {
      total: row.total,
      severities: {
        debug: row.debug,
        info: row.info,
        warn: row.warn,
        error: row.error,
      },
    };

    res.json(cachedStats);
  } catch (err) {
    console.error('Error in /api/stats:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
