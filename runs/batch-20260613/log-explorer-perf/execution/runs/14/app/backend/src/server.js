import express from 'express';
import cors from 'cors';
import { initDb, getDb, SEVERITIES } from './db.js';

const PORT = process.env.PORT || 3001;
const MAX_LIMIT = 200;

const app = express();
app.use(cors());
app.use(express.json());

/**
 * Parse and validate query params for GET /api/logs.
 * Returns { error } on validation failure, or the parsed values.
 */
function parseLogParams(query) {
  const rawOffset = query.offset ?? '0';
  const rawLimit = query.limit ?? '100';
  const severity = query.severity;
  const q = query.q;

  if (!/^\d+$/.test(String(rawOffset))) {
    return { error: 'offset must be a non-negative integer' };
  }
  if (!/^\d+$/.test(String(rawLimit))) {
    return { error: 'limit must be a non-negative integer' };
  }
  const offset = parseInt(rawOffset, 10);
  const limit = parseInt(rawLimit, 10);

  if (offset < 0) return { error: 'offset must be >= 0' };
  if (limit < 1) return { error: 'limit must be >= 1' };
  if (limit > MAX_LIMIT) return { error: `limit must be <= ${MAX_LIMIT}` };

  if (severity !== undefined && severity !== '' && !SEVERITIES.includes(severity)) {
    return { error: `unknown severity '${severity}'` };
  }

  return {
    offset,
    limit,
    severity: severity && severity !== '' ? severity : null,
    q: q && String(q).trim() !== '' ? String(q) : null,
  };
}

/**
 * Build the WHERE clause fragment and parameter list shared by the count and
 * the windowed data queries.
 */
function buildFilter(severity, q) {
  const conditions = [];
  const params = [];
  if (severity) {
    params.push(severity);
    conditions.push(`severity = $${params.length}`);
  }
  if (q) {
    // Case-insensitive substring match. Escape LIKE metacharacters.
    const escaped = q.replace(/([\\%_])/g, '\\$1');
    params.push(`%${escaped.toLowerCase()}%`);
    conditions.push(`lower(message) LIKE $${params.length} ESCAPE '\\'`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params };
}

app.get('/api/logs', async (req, res) => {
  const parsed = parseLogParams(req.query);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }
  const { offset, limit, severity, q } = parsed;
  const db = getDb();

  const { where, params } = buildFilter(severity, q);

  try {
    // Total count for the current filter (drives the virtual scrollbar size).
    const countSql = `SELECT COUNT(*)::int AS total FROM logs ${where};`;
    const countRes = await db.query(countSql, params);
    const total = countRes.rows[0].total;

    // Windowed slice, ordered by ts DESC (id DESC as a stable tiebreaker).
    const dataSql = `
      SELECT id, ts, severity, service, message
      FROM logs
      ${where}
      ORDER BY ts DESC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2};
    `;
    const dataRes = await db.query(dataSql, [...params, limit, offset]);

    res.json({ total, rows: dataRes.rows });
  } catch (err) {
    console.error('[api/logs] error', err);
    res.status(500).json({ error: 'query failed' });
  }
});

app.get('/api/stats', async (_req, res) => {
  const db = getDb();
  try {
    const totalRes = await db.query('SELECT COUNT(*)::int AS total FROM logs;');
    const bySevRes = await db.query(
      'SELECT severity, COUNT(*)::int AS count FROM logs GROUP BY severity;'
    );
    const bySeverity = {};
    for (const sev of SEVERITIES) bySeverity[sev] = 0;
    for (const row of bySevRes.rows) bySeverity[row.severity] = row.count;
    res.json({ total: totalRes.rows[0].total, bySeverity });
  } catch (err) {
    console.error('[api/stats] error', err);
    res.status(500).json({ error: 'query failed' });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

async function main() {
  const t0 = Date.now();
  await initDb();
  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT} (boot ${Date.now() - t0}ms)`);
  });
}

main().catch((err) => {
  console.error('[server] fatal', err);
  process.exit(1);
});
