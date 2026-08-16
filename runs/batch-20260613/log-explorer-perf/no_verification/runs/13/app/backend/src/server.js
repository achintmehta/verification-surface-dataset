import express from 'express';
import cors from 'cors';
import { getDb, seedIfNeeded, SEVERITIES } from './db.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const MAX_LIMIT = 200;

const app = express();
app.use(cors());
app.use(express.json());

let db;

// --- Validation helpers -----------------------------------------------------

function parseNonNegInt(value, { max } = {}) {
  if (value === undefined) return { ok: true, value: undefined };
  if (!/^\d+$/.test(String(value))) return { ok: false };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return { ok: false };
  if (max !== undefined && n > max) return { ok: false };
  return { ok: true, value: n };
}

// --- Routes ------------------------------------------------------------------

app.get('/api/logs', async (req, res) => {
  const { offset, limit, severity, q } = req.query;

  const offsetParsed = parseNonNegInt(offset);
  if (!offsetParsed.ok) {
    return res.status(400).json({ error: 'offset must be a non-negative integer' });
  }
  const offsetVal = offsetParsed.value ?? 0;

  const limitParsed = parseNonNegInt(limit, { max: MAX_LIMIT });
  if (!limitParsed.ok) {
    return res
      .status(400)
      .json({ error: `limit must be a non-negative integer no greater than ${MAX_LIMIT}` });
  }
  let limitVal = limitParsed.value ?? 100;
  if (limitVal === 0) limitVal = 0; // allow explicit 0 (count only)
  limitVal = Math.min(limitVal, MAX_LIMIT);

  if (severity !== undefined && !SEVERITIES.includes(String(severity))) {
    return res.status(400).json({ error: 'unknown severity' });
  }

  const conditions = [];
  const params = [];
  let p = 0;

  if (severity !== undefined) {
    conditions.push(`severity = $${++p}`);
    params.push(String(severity));
  }
  if (q !== undefined && String(q).length > 0) {
    conditions.push(`lower(message) LIKE $${++p}`);
    // Escape LIKE special chars, then wrap with %.
    const escaped = String(q).toLowerCase().replace(/([\\%_])/g, '\\$1');
    params.push(`%${escaped}%`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const countSql = `SELECT COUNT(*)::int AS total FROM logs ${whereClause};`;
    const countRes = await db.query(countSql, params);
    const total = countRes.rows[0].total;

    const rowsParams = params.slice();
    const limitIdx = ++p;
    const offsetIdx = ++p;
    rowsParams.push(limitVal, offsetVal);

    const rowsSql = `
      SELECT id, ts, severity, service, message
      FROM logs
      ${whereClause}
      ORDER BY ts DESC, id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx};
    `;
    const rowsRes = await db.query(rowsSql, rowsParams);

    res.json({ total, rows: rowsRes.rows });
  } catch (err) {
    console.error('query error', err);
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
    for (const s of SEVERITIES) bySeverity[s] = 0;
    for (const row of bySevRes.rows) bySeverity[row.severity] = row.c;
    res.json({ total: totalRes.rows[0].total, bySeverity });
  } catch (err) {
    console.error('stats error', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// --- Boot --------------------------------------------------------------------

async function boot() {
  const bootStart = Date.now();
  db = await getDb();
  await seedIfNeeded(db);
  app.listen(PORT, () => {
    console.log(`Log explorer API listening on http://localhost:${PORT}`);
    console.log(`Boot completed in ${Date.now() - bootStart}ms`);
  });
}

boot().catch((err) => {
  console.error('Failed to boot server:', err);
  process.exit(1);
});
