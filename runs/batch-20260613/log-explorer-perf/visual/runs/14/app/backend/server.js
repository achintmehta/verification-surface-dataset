import express from 'express';
import cors from 'cors';
import { getDb, SEVERITIES } from './db.js';

const PORT = process.env.PORT || 3001;
const MAX_LIMIT = 200;

const app = express();
app.use(cors());
app.use(express.json());

let db;

/**
 * GET /api/logs?offset=&limit=&severity=&q=
 * Returns { total, rows } ordered by ts DESC (id DESC tiebreak).
 */
app.get('/api/logs', async (req, res) => {
  // --- validate params ---
  const rawOffset = req.query.offset ?? '0';
  const rawLimit = req.query.limit ?? '100';
  const severity = req.query.severity ? String(req.query.severity) : '';
  const q = req.query.q != null ? String(req.query.q) : '';

  const offset = Number(rawOffset);
  const limit = Number(rawLimit);

  if (!Number.isInteger(offset) || offset < 0) {
    return res.status(400).json({ error: 'offset must be a non-negative integer' });
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    return res.status(400).json({ error: 'limit must be a positive integer' });
  }
  if (limit > MAX_LIMIT) {
    return res.status(400).json({ error: `limit must not exceed ${MAX_LIMIT}` });
  }
  if (severity && !SEVERITIES.includes(severity)) {
    return res.status(400).json({ error: `unknown severity: ${severity}` });
  }

  // --- build WHERE clause ---
  const where = [];
  const params = [];
  let p = 1;
  if (severity) {
    where.push(`severity = $${p++}`);
    params.push(severity);
  }
  if (q) {
    where.push(`message ILIKE $${p++}`);
    params.push('%' + escapeLike(q) + '%');
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  try {
    // total count for this filter combination
    const countSql = `SELECT COUNT(*)::int AS c FROM logs ${whereSql};`;
    const countRes = await db.query(countSql, params);
    const total = countRes.rows[0].c;

    const rowsSql = `
      SELECT id, ts, severity, service, message
      FROM logs
      ${whereSql}
      ORDER BY ts DESC, id DESC
      LIMIT $${p++} OFFSET $${p++};
    `;
    const rowsRes = await db.query(rowsSql, [...params, limit, offset]);

    res.json({ total, rows: rowsRes.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'query failed' });
  }
});

/**
 * GET /api/stats -> { total, bySeverity: {debug, info, warn, error} }
 */
app.get('/api/stats', async (_req, res) => {
  try {
    const r = await db.query(
      `SELECT severity, COUNT(*)::int AS c FROM logs GROUP BY severity;`
    );
    const bySeverity = { debug: 0, info: 0, warn: 0, error: 0 };
    let total = 0;
    for (const row of r.rows) {
      bySeverity[row.severity] = row.c;
      total += row.c;
    }
    res.json({ total, bySeverity });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'stats failed' });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

function escapeLike(s) {
  // Escape LIKE wildcards so user input is treated literally as a substring.
  return s.replace(/([%_\\])/g, '\\$1');
}

async function main() {
  const t0 = Date.now();
  console.log('[boot] initializing database...');
  db = await getDb();
  console.log(`[boot] database ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  app.listen(PORT, () => {
    console.log(`[boot] server listening on http://localhost:${PORT}`);
  });
}

main().catch((e) => {
  console.error('fatal boot error', e);
  process.exit(1);
});
