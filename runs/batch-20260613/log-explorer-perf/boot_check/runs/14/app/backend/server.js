'use strict';

const express = require('express');
const cors = require('cors');
const { getDb, initDb, SEVERITIES } = require('./db');

const PORT = process.env.PORT || 3001;
const MAX_LIMIT = 200;

const app = express();
app.use(cors());
app.use(express.json());

// Parse and validate query parameters for /api/logs.
// Returns { error } on failure or { offset, limit, severity, q } on success.
function parseLogParams(query) {
  const rawOffset = query.offset;
  const rawLimit = query.limit;

  let offset = 0;
  if (rawOffset !== undefined) {
    if (!/^\d+$/.test(String(rawOffset))) {
      return { error: 'offset must be a non-negative integer' };
    }
    offset = parseInt(rawOffset, 10);
    if (Number.isNaN(offset) || offset < 0) {
      return { error: 'offset must be a non-negative integer' };
    }
  }

  let limit = 100;
  if (rawLimit !== undefined) {
    if (!/^\d+$/.test(String(rawLimit))) {
      return { error: 'limit must be a positive integer' };
    }
    limit = parseInt(rawLimit, 10);
    if (Number.isNaN(limit) || limit < 1) {
      return { error: 'limit must be a positive integer' };
    }
    if (limit > MAX_LIMIT) {
      return { error: `limit must not exceed ${MAX_LIMIT}` };
    }
  }

  let severity = null;
  if (query.severity !== undefined && query.severity !== '') {
    severity = String(query.severity);
    if (!SEVERITIES.includes(severity)) {
      return { error: `severity must be one of ${SEVERITIES.join(', ')}` };
    }
  }

  let q = null;
  if (query.q !== undefined && String(query.q).length > 0) {
    q = String(query.q);
  }

  return { offset, limit, severity, q };
}

// Escape LIKE special characters so user input is treated literally.
function escapeLike(s) {
  return s.replace(/([\\%_])/g, '\\$1');
}

// Build WHERE clause fragments and parameter list.
function buildFilters(severity, q) {
  const clauses = [];
  const params = [];
  if (severity) {
    params.push(severity);
    clauses.push(`severity = $${params.length}`);
  }
  if (q) {
    params.push('%' + escapeLike(q.toLowerCase()) + '%');
    clauses.push(`message_lc LIKE $${params.length}`);
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  return { where, params };
}

// The corpus is static after seeding, so counts for the unfiltered case and
// for severity-only filters never change. Cache them to keep those very common
// query shapes off a full COUNT(*) scan on every request.
const countCache = new Map(); // key -> total

function countCacheKey(severity, q) {
  if (q) return null; // substring counts are not cached (open-ended input)
  return `sev:${severity || ''}`;
}

app.get('/api/logs', async (req, res) => {
  const parsed = parseLogParams(req.query);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }
  const { offset, limit, severity, q } = parsed;

  try {
    const db = await getDb();
    const { where, params } = buildFilters(severity, q);

    const cacheKey = countCacheKey(severity, q);
    let total;
    if (cacheKey !== null && countCache.has(cacheKey)) {
      total = countCache.get(cacheKey);
    } else {
      const countSql = `SELECT COUNT(*)::int AS total FROM logs ${where}`;
      const countRes = await db.query(countSql, params);
      total = countRes.rows[0].total;
      if (cacheKey !== null) countCache.set(cacheKey, total);
    }

    // Ordered by ts DESC (id DESC tiebreak) using the supporting indexes.
    const rowsParams = params.slice();
    rowsParams.push(limit);
    const limitIdx = rowsParams.length;
    rowsParams.push(offset);
    const offsetIdx = rowsParams.length;

    const rowsSql = `
      SELECT id, ts, severity, service, message
      FROM logs
      ${where}
      ORDER BY ts DESC, id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;
    const rowsRes = await db.query(rowsSql, rowsParams);

    res.json({ total, rows: rowsRes.rows });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('logs query error:', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const db = await getDb();
    const totalRes = await db.query('SELECT COUNT(*)::int AS total FROM logs');
    const bySevRes = await db.query(
      'SELECT severity, COUNT(*)::int AS count FROM logs GROUP BY severity'
    );
    const bySeverity = {};
    for (const sev of SEVERITIES) bySeverity[sev] = 0;
    for (const row of bySevRes.rows) bySeverity[row.severity] = row.count;
    res.json({ total: totalRes.rows[0].total, bySeverity });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('stats query error:', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

async function start() {
  const t0 = Date.now();
  await initDb();
  // eslint-disable-next-line no-console
  console.log('DB ready in %dms', Date.now() - t0);
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log('Log explorer API listening on http://localhost:%d', PORT);
  });
}

if (require.main === module) {
  start().catch((e) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start:', e);
    process.exit(1);
  });
}

module.exports = { app, parseLogParams, buildFilters };
