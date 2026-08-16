import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const MAX_LIMIT = 200;
const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);

let dbReady = getDb();

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true });
});

/**
 * GET /api/logs?offset=&limit=&severity=&q=
 * Returns { total, rows } ordered by ts DESC.
 */
app.get('/api/logs', async (req, res) => {
  const db = await dbReady;

  // --- Parse & validate ---
  const rawOffset = req.query.offset ?? '0';
  const rawLimit = req.query.limit ?? '100';
  const severity = req.query.severity;
  const q = req.query.q;

  const offset = Number(rawOffset);
  const limit = Number(rawLimit);

  if (!Number.isInteger(offset) || offset < 0) {
    return res.status(400).json({ error: 'offset must be a non-negative integer' });
  }
  if (!Number.isInteger(limit) || limit < 0) {
    return res.status(400).json({ error: 'limit must be a non-negative integer' });
  }
  if (limit > MAX_LIMIT) {
    return res.status(400).json({ error: `limit must not exceed ${MAX_LIMIT}` });
  }
  if (severity !== undefined && severity !== '' && !VALID_SEVERITIES.has(severity)) {
    return res.status(400).json({ error: 'unknown severity' });
  }

  // --- Build WHERE clause ---
  const conds = [];
  const params = [];
  let p = 1;

  if (severity !== undefined && severity !== '') {
    conds.push(`severity = $${p++}`);
    params.push(severity);
  }
  if (q !== undefined && q !== '') {
    // Case-insensitive substring; lower(message) matches the trgm index.
    conds.push(`message_lc LIKE $${p++}`);
    params.push('%' + String(q).toLowerCase() + '%');
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  try {
    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM logs ${where};`,
      params
    );
    const total = countRes.rows[0].total;

    const rowsRes = await db.query(
      `SELECT id, ts, severity, service, message
       FROM logs ${where}
       ORDER BY ts DESC, id DESC
       LIMIT $${p++} OFFSET $${p++};`,
      [...params, limit, offset]
    );

    res.json({ total, rows: rowsRes.rows });
  } catch (e) {
    console.error('query error', e);
    res.status(500).json({ error: 'query failed' });
  }
});

/**
 * GET /api/stats -> { total, bySeverity: { debug, info, warn, error } }
 */
app.get('/api/stats', async (_req, res) => {
  const db = await dbReady;
  try {
    const totalRes = await db.query('SELECT COUNT(*)::int AS total FROM logs;');
    const bySevRes = await db.query(
      'SELECT severity, COUNT(*)::int AS c FROM logs GROUP BY severity;'
    );
    const bySeverity = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const r of bySevRes.rows) bySeverity[r.severity] = r.c;
    res.json({ total: totalRes.rows[0].total, bySeverity });
  } catch (e) {
    console.error('stats error', e);
    res.status(500).json({ error: 'stats failed' });
  }
});

async function main() {
  const t0 = Date.now();
  await dbReady;
  console.log(`DB ready in ${Date.now() - t0}ms`);
  app.listen(PORT, () => {
    console.log(`Log explorer API listening on http://localhost:${PORT}`);
  });
}

main().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});
