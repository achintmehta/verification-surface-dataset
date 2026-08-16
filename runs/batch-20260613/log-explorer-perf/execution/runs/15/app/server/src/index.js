import express from 'express';
import cors from 'cors';
import { getDb, seedIfNeeded, SEVERITIES } from './db.js';

const PORT = process.env.PORT || 3001;
const MAX_LIMIT = 200;

const app = express();
app.use(cors());
app.use(express.json());

let dbReady = false;

// ---- Parameter validation ---------------------------------------------------
function parseListParams(query) {
  const errors = [];

  let offset = 0;
  if (query.offset !== undefined) {
    offset = Number(query.offset);
    if (!Number.isInteger(offset) || offset < 0) {
      errors.push('offset must be a non-negative integer');
    }
  }

  let limit = 100;
  if (query.limit !== undefined) {
    limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit <= 0) {
      errors.push('limit must be a positive integer');
    } else if (limit > MAX_LIMIT) {
      errors.push(`limit must not exceed ${MAX_LIMIT}`);
    }
  }

  let severity = null;
  if (query.severity !== undefined && query.severity !== '') {
    severity = String(query.severity).toLowerCase();
    if (!SEVERITIES.includes(severity)) {
      errors.push(`severity must be one of ${SEVERITIES.join(', ')}`);
    }
  }

  let q = null;
  if (query.q !== undefined && String(query.q).trim() !== '') {
    q = String(query.q);
  }

  return { offset, limit, severity, q, errors };
}

function buildWhere(severity, q) {
  const clauses = [];
  const params = [];
  if (severity) {
    params.push(severity);
    clauses.push(`severity = $${params.length}`);
  }
  if (q) {
    params.push('%' + q.toLowerCase() + '%');
    clauses.push(`lower(message) LIKE $${params.length}`);
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  return { where, params };
}

app.get('/api/logs', async (req, res) => {
  const { offset, limit, severity, q, errors } = parseListParams(req.query);
  if (errors.length) {
    return res.status(400).json({ error: 'invalid parameters', details: errors });
  }

  try {
    const db = await getDb();
    const { where, params } = buildWhere(severity, q);

    const totalRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM logs ${where}`,
      params
    );
    const total = totalRes.rows[0].total;

    const rowParams = params.slice();
    rowParams.push(limit, offset);
    const rowsRes = await db.query(
      `SELECT id, ts, severity, service, message
         FROM logs
         ${where}
         ORDER BY ts DESC, id DESC
         LIMIT $${rowParams.length - 1} OFFSET $${rowParams.length}`,
      rowParams
    );

    res.json({ total, rows: rowsRes.rows });
  } catch (err) {
    console.error('GET /api/logs failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/stats', async (_req, res) => {
  try {
    const db = await getDb();
    const totalRes = await db.query('SELECT COUNT(*)::int AS total FROM logs');
    const perSevRes = await db.query(
      `SELECT severity, COUNT(*)::int AS count
         FROM logs GROUP BY severity`
    );
    const bySeverity = {};
    for (const s of SEVERITIES) bySeverity[s] = 0;
    for (const row of perSevRes.rows) bySeverity[row.severity] = row.count;

    res.json({ total: totalRes.rows[0].total, bySeverity });
  } catch (err) {
    console.error('GET /api/stats failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, dbReady });
});

async function boot() {
  const started = Date.now();
  await getDb();
  await seedIfNeeded();
  dbReady = true;
  app.listen(PORT, () => {
    console.log(
      `Log explorer server listening on http://localhost:${PORT} ` +
        `(boot ${Date.now() - started}ms)`
    );
  });
}

boot().catch((err) => {
  console.error('Fatal boot error:', err);
  process.exit(1);
});
