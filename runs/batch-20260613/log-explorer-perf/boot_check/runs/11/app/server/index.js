import express from 'express';
import cors from 'cors';
import { getDb, SEVERITY_SET } from './db.js';

const PORT = process.env.PORT || 3001;
const MAX_LIMIT = 200;

const app = express();
app.use(cors());
app.use(express.json());

let db;

// Validate & parse query params for /api/logs. Returns { params } or { error }.
function parseLogParams(query) {
  const rawOffset = query.offset ?? '0';
  const rawLimit = query.limit ?? '100';

  if (!/^\d+$/.test(String(rawOffset))) {
    return { error: 'offset must be a non-negative integer' };
  }
  if (!/^\d+$/.test(String(rawLimit))) {
    return { error: 'limit must be a positive integer' };
  }

  const offset = parseInt(rawOffset, 10);
  const limit = parseInt(rawLimit, 10);

  if (offset < 0) return { error: 'offset must be >= 0' };
  if (limit < 1) return { error: 'limit must be >= 1' };
  if (limit > MAX_LIMIT) return { error: `limit must be <= ${MAX_LIMIT}` };

  let severity = query.severity;
  if (severity !== undefined && severity !== '' && severity !== 'all') {
    if (!SEVERITY_SET.has(severity)) {
      return { error: `unknown severity '${severity}'` };
    }
  } else {
    severity = null;
  }

  const q = typeof query.q === 'string' && query.q.trim() !== '' ? query.q : null;

  return { params: { offset, limit, severity, q } };
}

// Build a parameterized WHERE clause from filters.
function buildWhere({ severity, q }) {
  const clauses = [];
  const params = [];
  if (severity) {
    params.push(severity);
    clauses.push(`severity = $${params.length}`);
  }
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    clauses.push(`message_lc LIKE $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

app.get('/api/logs', async (req, res) => {
  const parsed = parseLogParams(req.query);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }
  const { offset, limit, severity, q } = parsed.params;

  try {
    const { where, params } = buildWhere({ severity, q });

    const countSql = `SELECT COUNT(*)::int AS total FROM logs ${where};`;
    const countRes = await db.query(countSql, params);
    const total = countRes.rows[0].total;

    const rowParams = params.slice();
    rowParams.push(limit);
    const limitIdx = rowParams.length;
    rowParams.push(offset);
    const offsetIdx = rowParams.length;

    const rowsSql = `
      SELECT id, ts, severity, service, message
      FROM logs
      ${where}
      ORDER BY ts DESC, id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx};
    `;
    const rowsRes = await db.query(rowsSql, rowParams);

    res.json({ total, rows: rowsRes.rows });
  } catch (e) {
    console.error('[api/logs] error', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/stats', async (_req, res) => {
  try {
    const totalRes = await db.query('SELECT COUNT(*)::int AS total FROM logs;');
    const bySevRes = await db.query(
      'SELECT severity, COUNT(*)::int AS c FROM logs GROUP BY severity;'
    );
    const bySeverity = {};
    for (const r of bySevRes.rows) bySeverity[r.severity] = r.c;
    res.json({ total: totalRes.rows[0].total, bySeverity });
  } catch (e) {
    console.error('[api/stats] error', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

async function start() {
  const t0 = Date.now();
  db = await getDb();
  console.log(`[server] db ready in ${Date.now() - t0}ms`);
  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

start().catch((e) => {
  console.error('[server] fatal startup error', e);
  process.exit(1);
});
