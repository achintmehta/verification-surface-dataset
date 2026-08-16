import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';

const PORT = process.env.PORT || 3001;
const MAX_LIMIT = 200;
const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);

const app = express();
app.use(cors());
app.use(express.json());

let dbReady = false;
let dbPromise;

// Kick off DB init (which includes first-boot seeding) immediately.
const bootStart = Date.now();
dbPromise = getDb()
  .then((db) => {
    dbReady = true;
    console.log('DB ready in %dms (serving).', Date.now() - bootStart);
    return db;
  })
  .catch((err) => {
    console.error('Fatal DB init error:', err);
    process.exit(1);
  });

function parseParams(query) {
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
    if (!Number.isInteger(limit) || limit < 1) {
      errors.push('limit must be a positive integer');
    } else if (limit > MAX_LIMIT) {
      errors.push(`limit must not exceed ${MAX_LIMIT}`);
    }
  }

  let severity = null;
  if (query.severity !== undefined && query.severity !== '') {
    severity = String(query.severity);
    if (!VALID_SEVERITIES.has(severity)) {
      errors.push('severity must be one of debug, info, warn, error');
    }
  }

  let q = null;
  if (query.q !== undefined && query.q !== '') {
    q = String(query.q);
  }

  return { offset, limit, severity, q, errors };
}

// Build the WHERE clause + params array from filters.
function buildWhere(severity, q, startIdx = 1) {
  const clauses = [];
  const params = [];
  let idx = startIdx;
  if (severity) {
    clauses.push(`severity = $${idx++}`);
    params.push(severity);
  }
  if (q) {
    clauses.push(`lower(message) LIKE $${idx++}`);
    params.push('%' + q.toLowerCase().replace(/[\\%_]/g, (m) => '\\' + m) + '%');
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  return { where, params, nextIdx: idx };
}

app.get('/api/logs', async (req, res) => {
  const { offset, limit, severity, q, errors } = parseParams(req.query);
  if (errors.length) {
    return res.status(400).json({ error: errors.join('; ') });
  }
  try {
    const db = await dbPromise;

    const wCount = buildWhere(severity, q, 1);
    const countSql = `SELECT COUNT(*)::int AS total FROM logs ${wCount.where};`;
    const countRes = await db.query(countSql, wCount.params);
    const total = countRes.rows[0].total;

    const wRows = buildWhere(severity, q, 1);
    const rowsSql =
      `SELECT id, ts, severity, service, message FROM logs ${wRows.where} ` +
      `ORDER BY ts DESC, id DESC ` +
      `LIMIT $${wRows.nextIdx} OFFSET $${wRows.nextIdx + 1};`;
    const rowsRes = await db.query(rowsSql, [...wRows.params, limit, offset]);

    res.json({ total, rows: rowsRes.rows });
  } catch (err) {
    console.error('GET /api/logs error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const db = await dbPromise;
    const totalRes = await db.query('SELECT COUNT(*)::int AS total FROM logs;');
    const bySevRes = await db.query(
      'SELECT severity, COUNT(*)::int AS c FROM logs GROUP BY severity;'
    );
    const bySeverity = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const r of bySevRes.rows) bySeverity[r.severity] = r.c;
    res.json({ total: totalRes.rows[0].total, bySeverity });
  } catch (err) {
    console.error('GET /api/stats error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ready: dbReady });
});

app.listen(PORT, () => {
  console.log('Log explorer server listening on http://localhost:%d', PORT);
});
