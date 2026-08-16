import express from 'express';
import cors from 'cors';
import { getDb, SEVERITIES } from './db.js';

const PORT = process.env.PORT || 3001;
const MAX_LIMIT = 200;

const app = express();
app.use(cors());
app.use(express.json());

// The DB is initialized (and seeded on first boot) before we start serving.
let db = null;

function parseIntStrict(v) {
  if (v === undefined || v === null || v === '') return null;
  if (!/^-?\d+$/.test(String(v).trim())) return NaN;
  return parseInt(v, 10);
}

app.get('/api/health', (req, res) => {
  res.json({ ok: db !== null });
});

// GET /api/stats -> { total, bySeverity: { debug, info, warn, error } }
app.get('/api/stats', async (req, res) => {
  try {
    const totalRes = await db.query('SELECT COUNT(*)::int AS c FROM logs;');
    const sevRes = await db.query(
      'SELECT severity, COUNT(*)::int AS c FROM logs GROUP BY severity;'
    );
    const bySeverity = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const row of sevRes.rows) bySeverity[row.severity] = row.c;
    res.json({ total: totalRes.rows[0].c, bySeverity });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/logs?offset=&limit=&severity=&q= -> { total, rows }
app.get('/api/logs', async (req, res) => {
  const offset = parseIntStrict(req.query.offset);
  const limit = parseIntStrict(req.query.limit);
  const severity = req.query.severity;
  const q = req.query.q;

  // ---- validation ----
  const off = offset === null ? 0 : offset;
  const lim = limit === null ? 100 : limit;

  if (Number.isNaN(off) || off < 0) {
    return res.status(400).json({ error: 'invalid_offset' });
  }
  if (Number.isNaN(lim) || lim < 0) {
    return res.status(400).json({ error: 'invalid_limit' });
  }
  if (lim > MAX_LIMIT) {
    return res.status(400).json({ error: 'limit_exceeds_cap', cap: MAX_LIMIT });
  }
  if (severity !== undefined && severity !== '' && !SEVERITIES.includes(severity)) {
    return res.status(400).json({ error: 'unknown_severity' });
  }

  // ---- build query ----
  const where = [];
  const params = [];
  let p = 1;

  if (severity !== undefined && severity !== '') {
    where.push(`severity = $${p++}`);
    params.push(severity);
  }
  if (q !== undefined && q !== '') {
    // Case-insensitive substring. Escape LIKE metacharacters in the term.
    const escaped = String(q).replace(/([\\%_])/g, '\\$1');
    where.push(`lower(message) LIKE $${p++}`);
    params.push('%' + escaped.toLowerCase() + '%');
  }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  try {
    const countSql = `SELECT COUNT(*)::int AS c FROM logs ${whereSql};`;
    const countRes = await db.query(countSql, params);
    const total = countRes.rows[0].c;

    const rowsParams = params.slice();
    const limIdx = p++;
    const offIdx = p++;
    rowsParams.push(lim, off);

    const rowsSql = `
      SELECT id, ts, severity, service, message
      FROM logs
      ${whereSql}
      ORDER BY ts DESC, id DESC
      LIMIT $${limIdx} OFFSET $${offIdx};
    `;
    const rowsRes = await db.query(rowsSql, rowsParams);

    res.json({ total, rows: rowsRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

async function main() {
  console.log('[server] Initializing database (seeding on first boot may take a moment)...');
  const bootStart = Date.now();
  db = await getDb();
  console.log(`[server] DB ready in ${((Date.now() - bootStart) / 1000).toFixed(1)}s.`);

  app.listen(PORT, () => {
    console.log(`[server] Log explorer API listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
