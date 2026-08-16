import { Router } from 'express';
import { getDB } from './db.js';

const router = Router();

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

router.get('/api/logs', async (req, res) => {
  try {
    const db = getDB();

    // Parse and validate offset
    let offset = parseInt(req.query.offset, 10);
    if (req.query.offset !== undefined && req.query.offset !== '') {
      if (isNaN(offset) || offset < 0) {
        return res.status(400).json({ error: 'offset must be a non-negative integer' });
      }
    } else {
      offset = 0;
    }

    // Parse and validate limit
    let limit = parseInt(req.query.limit, 10);
    if (req.query.limit !== undefined && req.query.limit !== '') {
      if (isNaN(limit) || limit < 1) {
        return res.status(400).json({ error: 'limit must be a positive integer' });
      }
      if (limit > MAX_LIMIT) {
        return res.status(400).json({ error: `limit must not exceed ${MAX_LIMIT}` });
      }
    } else {
      limit = 50; // default
    }

    // Parse and validate severity
    const severity = req.query.severity;
    if (severity !== undefined && severity !== '') {
      if (!VALID_SEVERITIES.has(severity)) {
        return res.status(400).json({ error: `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}` });
      }
    }

    // Parse search query
    const q = req.query.q || '';

    // Build query
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (severity && severity !== '') {
      conditions.push(`severity = $${paramIdx++}`);
      params.push(severity);
    }

    if (q !== '') {
      conditions.push(`lower(message) LIKE $${paramIdx++}`);
      params.push(`%${q.toLowerCase()}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countQuery = `SELECT COUNT(*)::int AS total FROM logs ${whereClause}`;
    const countResult = await db.query(countQuery, params);
    const total = countResult.rows[0].total;

    // Get rows
    const dataQuery = `SELECT id, ts, severity, service, message FROM logs ${whereClause} ORDER BY ts DESC OFFSET $${paramIdx++} LIMIT $${paramIdx++}`;
    const dataParams = [...params, offset, limit];
    const dataResult = await db.query(dataQuery, dataParams);

    res.json({
      total,
      rows: dataResult.rows
    });
  } catch (err) {
    console.error('Error querying logs:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/api/stats', async (req, res) => {
  try {
    const db = getDB();

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
    res.json({
      total: row.total,
      severities: {
        debug: row.debug,
        info: row.info,
        warn: row.warn,
        error: row.error
      }
    });
  } catch (err) {
    console.error('Error getting stats:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
