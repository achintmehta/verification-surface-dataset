import express from 'express';
import cors from 'cors';
import { initDb, getDb } from './db.js';
import { SEVERITIES } from './seed.js';

const PORT = process.env.PORT || 3001;
const MAX_LIMIT = 200;

const app = express();
app.use(cors());
app.use(express.json());

// Escape a string for use inside an ILIKE pattern.
function escapeLike(s) {
  return s.replace(/[\\%_]/g, (m) => '\\' + m);
}

/**
 * Build the WHERE clause + params for a given filter set.
 * Returns { where, params }.
 */
function buildFilter(severity, q) {
  const clauses = [];
  const params = [];
  if (severity) {
    params.push(severity);
    clauses.push(`severity = $${params.length}`);
  }
  if (q) {
    params.push('%' + escapeLike(q.toLowerCase()) + '%');
    clauses.push(`lower(message) LIKE $${params.length}`);
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  return { where, params };
}

app.get('/api/logs', async (req, res) => {
  const db = getDb();

  // --- validate offset ---
  const offsetRaw = req.query.offset ?? '0';
  const offset = Number(offsetRaw);
  if (!Number.isInteger(offset) || offset < 0) {
    return res.status(400).json({ error: 'offset must be a non-negative integer' });
  }

  // --- validate limit ---
  const limitRaw = req.query.limit ?? '100';
  const limit = Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return res.status(400).json({ error: `limit must be an integer between 1 and ${MAX_LIMIT}` });
  }

  // --- validate severity ---
  let severity = req.query.severity;
  if (severity === undefined || severity === '') {
    severity = null;
  } else if (!SEVERITIES.includes(severity)) {
    return res.status(400).json({ error: `severity must be one of ${SEVERITIES.join(', ')}` });
  }

  // --- q (substring) ---
  let q = req.query.q;
  if (q === undefined) q = null;
  else {
    q = String(q).trim();
    if (q === '') q = null;
  }

  try {
    const { where, params } = buildFilter(severity, q);

    const countSql = `SELECT COUNT(*)::int AS total FROM logs ${where};`;
    const countRes = await db.query(countSql, params);
    const total = countRes.rows[0].total;

    const rowsParams = params.slice();
    rowsParams.push(limit);
    const limIdx = rowsParams.length;
    rowsParams.push(offset);
    const offIdx = rowsParams.length;

    const rowsSql = `
      SELECT id, ts, severity, service, message
      FROM logs
      ${where}
      ORDER BY ts DESC, id DESC
      LIMIT $${limIdx} OFFSET $${offIdx};
    `;
    const rowsRes = await db.query(rowsSql, rowsParams);

    res.json({ total, rows: rowsRes.rows });
  } catch (err) {
    console.error('[api] /api/logs error', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/stats', async (_req, res) => {
  const db = getDb();
  try {
    const totalRes = await db.query('SELECT COUNT(*)::int AS total FROM logs;');
    const bySevRes = await db.query(
      'SELECT severity, COUNT(*)::int AS n FROM logs GROUP BY severity;'
    );
    const bySeverity = {};
    for (const s of SEVERITIES) bySeverity[s] = 0;
    for (const row of bySevRes.rows) bySeverity[row.severity] = row.n;
    res.json({ total: totalRes.rows[0].total, bySeverity });
  } catch (err) {
    console.error('[api] /api/stats error', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

async function main() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`[api] listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('fatal', err);
  process.exit(1);
});
