import express from 'express';
import cors from 'cors';
import { initDb, getDb, VALID_SEVERITIES } from './db.js';

const PORT = process.env.PORT || 3001;
const MAX_LIMIT = 200;

const app = express();
app.use(cors());
app.use(express.json());

function parseIntStrict(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!/^-?\d+$/.test(String(value))) return NaN;
  return parseInt(value, 10);
}

/**
 * GET /api/logs?offset=&limit=&severity=&q=
 * Returns { total, rows } ordered by ts DESC (newest first).
 */
app.get('/api/logs', async (req, res) => {
  const db = getDb();

  // --- validate offset ---
  let offset = parseIntStrict(req.query.offset);
  if (offset === null) offset = 0;
  if (Number.isNaN(offset) || offset < 0) {
    return res.status(400).json({ error: 'offset must be a non-negative integer' });
  }

  // --- validate limit ---
  let limit = parseIntStrict(req.query.limit);
  if (limit === null) limit = 100;
  if (Number.isNaN(limit) || limit <= 0) {
    return res.status(400).json({ error: 'limit must be a positive integer' });
  }
  if (limit > MAX_LIMIT) {
    return res.status(400).json({ error: `limit cannot exceed ${MAX_LIMIT}` });
  }

  // --- validate severity ---
  const severity = req.query.severity ? String(req.query.severity) : null;
  if (severity !== null && !VALID_SEVERITIES.includes(severity)) {
    return res.status(400).json({ error: 'unknown severity' });
  }

  // --- q substring filter (case-insensitive) ---
  const q = req.query.q !== undefined && req.query.q !== null ? String(req.query.q) : '';

  // Build WHERE clause dynamically.
  const conds = [];
  const params = [];
  let p = 1;
  if (severity !== null) {
    conds.push(`severity = $${p++}`);
    params.push(severity);
  }
  if (q.trim() !== '') {
    conds.push(`lower(message) LIKE $${p++}`);
    // Escape LIKE wildcards in the user term.
    const escaped = q.toLowerCase().replace(/([\\%_])/g, '\\$1');
    params.push(`%${escaped}%`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  try {
    // Total count for the current filter.
    const totalRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM logs ${where}`,
      params
    );
    const total = totalRes.rows[0].total;

    // Windowed slice.
    const rowsRes = await db.query(
      `SELECT id, ts, severity, service, message
         FROM logs ${where}
         ORDER BY ts DESC, id DESC
         LIMIT $${p++} OFFSET $${p++}`,
      [...params, limit, offset]
    );

    res.json({ total, rows: rowsRes.rows });
  } catch (err) {
    console.error('query error', err);
    res.status(500).json({ error: 'internal error' });
  }
});

/**
 * GET /api/stats
 * Returns total row count and per-severity counts.
 */
app.get('/api/stats', async (_req, res) => {
  const db = getDb();
  try {
    const totalRes = await db.query(`SELECT COUNT(*)::int AS total FROM logs`);
    const bySevRes = await db.query(
      `SELECT severity, COUNT(*)::int AS count FROM logs GROUP BY severity`
    );
    const bySeverity = {};
    for (const s of VALID_SEVERITIES) bySeverity[s] = 0;
    for (const row of bySevRes.rows) bySeverity[row.severity] = row.count;
    res.json({ total: totalRes.rows[0].total, bySeverity });
  } catch (err) {
    console.error('stats error', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

async function main() {
  const t0 = Date.now();
  await initDb();
  app.listen(PORT, () => {
    console.log(
      `Log explorer server ready on http://localhost:${PORT} (boot ${((Date.now() - t0) / 1000).toFixed(1)}s)`
    );
  });
}

main().catch((err) => {
  console.error('fatal boot error', err);
  process.exit(1);
});
