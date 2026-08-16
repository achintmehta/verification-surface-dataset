import express from 'express';
import cors from 'cors';
import { getDb, initDb, SEVERITIES } from './db.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const MAX_LIMIT = 200;

const app = express();
app.use(cors());
app.use(express.json());

// --------------------------------------------------------------------------
// Validation helpers
// --------------------------------------------------------------------------

function parseIntParam(value, fallback) {
  if (value === undefined || value === null || value === '') return { ok: true, value: fallback };
  if (!/^-?\d+$/.test(String(value))) return { ok: false };
  return { ok: true, value: Number(value) };
}

// --------------------------------------------------------------------------
// GET /api/logs
// --------------------------------------------------------------------------

app.get('/api/logs', async (req, res) => {
  const db = await getDb();

  const offsetP = parseIntParam(req.query.offset, 0);
  const limitP = parseIntParam(req.query.limit, 100);

  if (!offsetP.ok || !limitP.ok) {
    return res.status(400).json({ error: 'offset and limit must be integers' });
  }

  const offset = offsetP.value;
  const limit = limitP.value;

  if (offset < 0) {
    return res.status(400).json({ error: 'offset must be >= 0' });
  }
  if (limit < 0) {
    return res.status(400).json({ error: 'limit must be >= 0' });
  }
  if (limit > MAX_LIMIT) {
    return res.status(400).json({ error: `limit must be <= ${MAX_LIMIT}` });
  }

  const severity = req.query.severity;
  if (severity !== undefined && severity !== '' && !SEVERITIES.includes(severity)) {
    return res.status(400).json({ error: `unknown severity: ${severity}` });
  }

  const q = req.query.q;
  if (q !== undefined && typeof q !== 'string') {
    return res.status(400).json({ error: 'q must be a string' });
  }

  // Build WHERE clause + params.
  const where = [];
  const params = [];
  let p = 1;

  if (severity !== undefined && severity !== '') {
    where.push(`severity = $${p++}`);
    params.push(severity);
  }
  if (q !== undefined && q !== '') {
    where.push(`lower(message) LIKE $${p++}`);
    params.push('%' + String(q).toLowerCase() + '%');
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  try {
    // total count of the filtered set
    const countSql = `SELECT COUNT(*)::int AS total FROM logs ${whereSql}`;
    const countRes = await db.query(countSql, params);
    const total = countRes.rows[0]?.total ?? 0;

    // window rows, ordered by ts DESC (tie-break id DESC for stable order)
    const rowsParams = params.slice();
    const limSql = `$${p++}`;
    const offSql = `$${p++}`;
    rowsParams.push(limit, offset);

    const rowsSql = `
      SELECT id, ts, severity, service, message
      FROM logs
      ${whereSql}
      ORDER BY ts DESC, id DESC
      LIMIT ${limSql} OFFSET ${offSql}
    `;
    const rowsRes = await db.query(rowsSql, rowsParams);

    res.json({ total, rows: rowsRes.rows });
  } catch (err) {
    console.error('[/api/logs] error', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// --------------------------------------------------------------------------
// GET /api/stats
// --------------------------------------------------------------------------

app.get('/api/stats', async (_req, res) => {
  const db = await getDb();
  try {
    const totalRes = await db.query('SELECT COUNT(*)::int AS total FROM logs;');
    const bySevRes = await db.query(
      'SELECT severity, COUNT(*)::int AS count FROM logs GROUP BY severity;'
    );
    const bySeverity = {};
    for (const s of SEVERITIES) bySeverity[s] = 0;
    for (const row of bySevRes.rows) bySeverity[row.severity] = row.count;

    res.json({ total: totalRes.rows[0]?.total ?? 0, bySeverity });
  } catch (err) {
    console.error('[/api/stats] error', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  console.log('[boot] initializing database...');
  await initDb();
  console.log(`[boot] database ready in ${Date.now() - t0}ms`);

  app.listen(PORT, () => {
    console.log(`[boot] log-explorer server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[boot] fatal', err);
  process.exit(1);
});
