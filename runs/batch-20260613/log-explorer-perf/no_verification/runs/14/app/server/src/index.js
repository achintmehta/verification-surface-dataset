import express from 'express';
import cors from 'cors';
import { getDb, SEVERITIES } from './db.js';

const PORT = process.env.PORT || 3001;
const MAX_LIMIT = 200;

const app = express();
app.use(cors());
app.use(express.json());

let db = null;

/**
 * Parse and validate the /api/logs query parameters.
 * Returns { error } (string) on failure, otherwise the normalized params.
 */
function parseLogsParams(query) {
  const rawOffset = query.offset ?? '0';
  const rawLimit = query.limit ?? '100';

  const offset = Number(rawOffset);
  const limit = Number(rawLimit);

  if (!Number.isInteger(offset) || offset < 0) {
    return { error: 'offset must be a non-negative integer' };
  }
  if (!Number.isInteger(limit) || limit < 1) {
    return { error: 'limit must be a positive integer' };
  }
  if (limit > MAX_LIMIT) {
    return { error: `limit must not exceed ${MAX_LIMIT}` };
  }

  const severity = query.severity;
  if (severity !== undefined && severity !== '' && !SEVERITIES.includes(severity)) {
    return { error: `unknown severity '${severity}'` };
  }

  const q = query.q !== undefined ? String(query.q) : '';

  return {
    offset,
    limit,
    severity: severity === '' ? undefined : severity,
    q,
  };
}

/**
 * Builds a WHERE clause (and parameter array) shared by count + rows queries.
 */
function buildFilter(severity, q) {
  const clauses = [];
  const params = [];

  if (severity) {
    params.push(severity);
    clauses.push(`severity = $${params.length}`);
  }
  if (q && q.trim() !== '') {
    // Case-insensitive substring match. lower(message) is indexed via pg_trgm.
    params.push(`%${q.toLowerCase()}%`);
    clauses.push(`lower(message) LIKE $${params.length}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

app.get('/api/logs', async (req, res) => {
  const parsed = parseLogsParams(req.query);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }
  const { offset, limit, severity, q } = parsed;

  try {
    const { where, params } = buildFilter(severity, q);

    // Total count for the filtered corpus (drives the virtual scrollbar).
    const countRes = await db.query(
      `SELECT COUNT(*)::bigint AS total FROM logs ${where};`,
      params
    );
    const total = Number(countRes.rows[0].total);

    // Windowed slice. Ordered by (ts DESC, id DESC) which is index-backed.
    const rowsParams = params.slice();
    rowsParams.push(limit);
    const limitIdx = rowsParams.length;
    rowsParams.push(offset);
    const offsetIdx = rowsParams.length;

    const rowsRes = await db.query(
      `SELECT id, ts, severity, service, message
         FROM logs
         ${where}
         ORDER BY ts DESC, id DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx};`,
      rowsParams
    );

    res.json({ total, rows: rowsRes.rows });
  } catch (err) {
    console.error('[api/logs] error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/stats', async (_req, res) => {
  try {
    const res1 = await db.query(
      `SELECT severity, COUNT(*)::bigint AS count FROM logs GROUP BY severity;`
    );
    const bySeverity = {};
    for (const s of SEVERITIES) bySeverity[s] = 0;
    let total = 0;
    for (const row of res1.rows) {
      const c = Number(row.count);
      bySeverity[row.severity] = c;
      total += c;
    }
    res.json({ total, bySeverity });
  } catch (err) {
    console.error('[api/stats] error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

async function main() {
  db = await getDb();
  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] fatal startup error:', err);
  process.exit(1);
});
