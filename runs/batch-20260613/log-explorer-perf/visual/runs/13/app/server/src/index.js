import express from 'express';
import cors from 'cors';
import { getDb, seedIfNeeded, SEVERITIES } from './db.js';

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

app.get('/api/logs', async (req, res) => {
  const db = await getDb();

  // Validate offset.
  let offset = parseIntStrict(req.query.offset);
  if (offset === null) offset = 0;
  if (Number.isNaN(offset) || offset < 0) {
    return res.status(400).json({ error: 'offset must be a non-negative integer' });
  }

  // Validate limit.
  let limit = parseIntStrict(req.query.limit);
  if (limit === null) limit = 100;
  if (Number.isNaN(limit) || limit < 1) {
    return res.status(400).json({ error: 'limit must be a positive integer' });
  }
  if (limit > MAX_LIMIT) {
    return res.status(400).json({ error: `limit must not exceed ${MAX_LIMIT}` });
  }

  // Validate severity.
  const severity = req.query.severity;
  if (severity !== undefined && severity !== '' && !SEVERITIES.includes(severity)) {
    return res.status(400).json({ error: 'unknown severity' });
  }

  const q = req.query.q;
  if (q !== undefined && typeof q !== 'string') {
    return res.status(400).json({ error: 'q must be a string' });
  }

  // Build WHERE clause.
  const where = [];
  const params = [];
  let p = 1;
  if (severity && severity !== '') {
    where.push(`severity = $${p++}`);
    params.push(severity);
  }
  if (q && q.trim() !== '') {
    where.push(`lower(message) LIKE $${p++}`);
    params.push('%' + q.toLowerCase() + '%');
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  try {
    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM logs ${whereSql};`,
      params
    );
    const total = countRes.rows[0].total;

    const rowsRes = await db.query(
      `SELECT id, ts, severity, service, message
       FROM logs
       ${whereSql}
       ORDER BY ts DESC, id DESC
       LIMIT $${p++} OFFSET $${p++};`,
      [...params, limit, offset]
    );

    res.json({ total, rows: rowsRes.rows });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('query error', err);
    res.status(500).json({ error: 'query failed' });
  }
});

app.get('/api/stats', async (_req, res) => {
  const db = await getDb();
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
    // eslint-disable-next-line no-console
    console.error('stats error', err);
    res.status(500).json({ error: 'stats failed' });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

async function main() {
  const t0 = Date.now();
  // eslint-disable-next-line no-console
  console.log('Initializing PGLite and seeding if needed...');
  const result = await seedIfNeeded();
  if (result.seeded) {
    // eslint-disable-next-line no-console
    console.log(`Seeded 100000 rows in ${result.elapsedMs}ms`);
  } else {
    // eslint-disable-next-line no-console
    console.log('Corpus already present, skipping seed');
  }
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Log explorer server listening on http://localhost:${PORT} (boot ${Date.now() - t0}ms)`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error', err);
  process.exit(1);
});
