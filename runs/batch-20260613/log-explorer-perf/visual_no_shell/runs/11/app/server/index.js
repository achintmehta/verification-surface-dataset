import express from 'express';
import cors from 'cors';
import { getDb, SEVERITIES, config } from './db.js';

const PORT = process.env.PORT || 3001;
const MAX_LIMIT = config.MAX_LIMIT;

const app = express();
app.use(cors());
app.use(express.json());

let db;

// Build a WHERE clause + params from validated filters.
function buildFilter(severity, q) {
  const clauses = [];
  const params = [];
  if (severity) {
    params.push(severity);
    clauses.push(`severity = $${params.length}`);
  }
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    clauses.push(`lower(message) LIKE $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

app.get('/api/logs', async (req, res) => {
  // --- validation ---
  const rawOffset = req.query.offset ?? '0';
  const rawLimit = req.query.limit ?? '100';
  const severity = req.query.severity ? String(req.query.severity) : '';
  const q = req.query.q != null ? String(req.query.q) : '';

  const offset = Number(rawOffset);
  const limit = Number(rawLimit);

  if (!Number.isInteger(offset) || offset < 0) {
    return res.status(400).json({ error: 'offset must be a non-negative integer' });
  }
  if (!Number.isInteger(limit) || limit < 1) {
    return res.status(400).json({ error: 'limit must be a positive integer' });
  }
  if (limit > MAX_LIMIT) {
    return res.status(400).json({ error: `limit must not exceed ${MAX_LIMIT}` });
  }
  if (severity && !SEVERITIES.includes(severity)) {
    return res.status(400).json({ error: `unknown severity '${severity}'` });
  }

  try {
    const { where, params } = buildFilter(severity, q);

    // total (exact) for the filter combination
    const totalRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM logs ${where};`,
      params,
    );
    const total = totalRes.rows[0].total;

    // windowed rows, newest first. Index on (ts DESC, id DESC) supports this.
    const rowParams = params.slice();
    rowParams.push(limit);
    rowParams.push(offset);
    const rowsRes = await db.query(
      `SELECT id, ts, severity, service, message
         FROM logs ${where}
        ORDER BY ts DESC, id DESC
        LIMIT $${rowParams.length - 1} OFFSET $${rowParams.length};`,
      rowParams,
    );

    res.json({ total, rows: rowsRes.rows });
  } catch (err) {
    console.error('[api/logs] error', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/stats', async (_req, res) => {
  try {
    const totalRes = await db.query(`SELECT COUNT(*)::int AS total FROM logs;`);
    const bySevRes = await db.query(
      `SELECT severity, COUNT(*)::int AS count FROM logs GROUP BY severity;`,
    );
    const bySeverity = {};
    for (const s of SEVERITIES) bySeverity[s] = 0;
    for (const r of bySevRes.rows) bySeverity[r.severity] = r.count;
    res.json({ total: totalRes.rows[0].total, bySeverity });
  } catch (err) {
    console.error('[api/stats] error', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: !!db }));

async function main() {
  const t0 = Date.now();
  db = await getDb();
  console.log('[server] db ready in %dms', Date.now() - t0);
  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] fatal', err);
  process.exit(1);
});
