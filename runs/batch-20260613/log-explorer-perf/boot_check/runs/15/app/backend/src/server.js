import express from 'express';
import cors from 'cors';
import { getDb, initDb, SEVERITIES } from './db.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const MAX_LIMIT = 200;

const app = express();
app.use(cors());
app.use(express.json());

let ready = false;

// Small cache of exact counts keyed by filter signature. Counts are stable
// because the corpus is static after seeding, so this keeps repeated windowed
// requests (e.g. while scrolling a filtered view) from re-scanning on every
// page fetch. Bounded size; cheap to rebuild.
const countCache = new Map();
const COUNT_CACHE_MAX = 500;

function countKey(severity, q) {
  return `${severity || ''}\u0000${q || ''}`;
}

function getCachedCount(key) {
  return countCache.has(key) ? countCache.get(key) : undefined;
}

function setCachedCount(key, value) {
  if (countCache.size >= COUNT_CACHE_MAX) {
    const first = countCache.keys().next().value;
    countCache.delete(first);
  }
  countCache.set(key, value);
}

app.get('/api/health', (req, res) => {
  res.json({ ready });
});

// GET /api/logs?offset=&limit=&severity=&q=
app.get('/api/logs', async (req, res) => {
  const rawOffset = req.query.offset;
  const rawLimit = req.query.limit;
  const severity = req.query.severity;
  const q = req.query.q;

  // Validate offset.
  let offset = 0;
  if (rawOffset !== undefined) {
    offset = Number(rawOffset);
    if (!Number.isInteger(offset) || offset < 0) {
      return res.status(400).json({ error: 'offset must be a non-negative integer' });
    }
  }

  // Validate limit.
  let limit = 100;
  if (rawLimit !== undefined) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1) {
      return res.status(400).json({ error: 'limit must be a positive integer' });
    }
    if (limit > MAX_LIMIT) {
      return res.status(400).json({ error: `limit must not exceed ${MAX_LIMIT}` });
    }
  }

  // Validate severity.
  if (severity !== undefined && severity !== '' && !SEVERITIES.includes(severity)) {
    return res.status(400).json({ error: `severity must be one of ${SEVERITIES.join(', ')}` });
  }

  const conditions = [];
  const params = [];
  let p = 1;

  if (severity && SEVERITIES.includes(severity)) {
    conditions.push(`severity = $${p++}`);
    params.push(severity);
  }

  if (typeof q === 'string' && q.length > 0) {
    conditions.push(`lower(message) LIKE $${p++}`);
    params.push('%' + q.toLowerCase() + '%');
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const db = await getDb();

    const key = countKey(severity, q);
    let total = getCachedCount(key);
    if (total === undefined) {
      const countSql = `SELECT COUNT(*)::int AS total FROM logs ${where}`;
      const countRes = await db.query(countSql, params);
      total = countRes.rows[0].total;
      setCachedCount(key, total);
    }

    const rowsParams = params.slice();
    const limitIdx = p++;
    const offsetIdx = p++;
    rowsParams.push(limit, offset);
    const rowsSql = `
      SELECT id, ts, severity, service, message
      FROM logs
      ${where}
      ORDER BY ts DESC, id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;
    const rowsRes = await db.query(rowsSql, rowsParams);

    res.json({ total, rows: rowsRes.rows });
  } catch (err) {
    console.error('Query error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /api/stats -> { total, bySeverity: { debug, info, warn, error } }
app.get('/api/stats', async (req, res) => {
  try {
    const db = await getDb();
    const totalRes = await db.query('SELECT COUNT(*)::int AS total FROM logs');
    const bySevRes = await db.query(
      'SELECT severity, COUNT(*)::int AS c FROM logs GROUP BY severity'
    );
    const bySeverity = {};
    for (const s of SEVERITIES) bySeverity[s] = 0;
    for (const row of bySevRes.rows) bySeverity[row.severity] = row.c;
    res.json({ total: totalRes.rows[0].total, bySeverity });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

async function main() {
  console.log('Initializing database...');
  const t0 = Date.now();
  await initDb();
  console.log(`DB init complete in ${Date.now() - t0}ms`);
  ready = true;

  app.listen(PORT, () => {
    console.log(`Log explorer API listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
