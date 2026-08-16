'use strict';

const express = require('express');
const cors = require('cors');
const { getDb, init, SEVERITIES } = require('./db');

const PORT = process.env.PORT || 3001;
const MAX_LIMIT = 200;

const app = express();
app.use(cors());
app.use(express.json());

// Serve the built frontend if present (production), harmless in dev.
const path = require('path');
app.use(express.static(path.join(__dirname, '..', 'dist')));

let db = null;

function parseWindowParams(query) {
  const errors = [];

  const offsetRaw = query.offset === undefined ? '0' : String(query.offset);
  const limitRaw = query.limit === undefined ? '100' : String(query.limit);

  const offset = Number(offsetRaw);
  const limit = Number(limitRaw);

  if (!Number.isInteger(offset) || offset < 0) {
    errors.push('offset must be a non-negative integer');
  }
  if (!Number.isInteger(limit) || limit < 1) {
    errors.push('limit must be a positive integer');
  } else if (limit > MAX_LIMIT) {
    errors.push('limit exceeds maximum of ' + MAX_LIMIT);
  }

  let severity = null;
  if (query.severity !== undefined && query.severity !== '') {
    severity = String(query.severity);
    if (!SEVERITIES.includes(severity)) {
      errors.push('unknown severity: ' + severity);
    }
  }

  let q = null;
  if (query.q !== undefined && query.q !== '') {
    q = String(query.q);
  }

  return { offset, limit, severity, q, errors };
}

// Build the shared WHERE clause + params for a filtered query.
function buildFilter(severity, q) {
  const clauses = [];
  const params = [];
  let p = 1;

  if (severity) {
    clauses.push(`severity = $${p++}`);
    params.push(severity);
  }
  if (q) {
    // Case-insensitive substring match. We compare against lower(message) so
    // the functional index on lower(message) is usable, and pass a lowercased
    // pattern to keep it index-friendly for anchored terms.
    clauses.push(`lower(message) LIKE $${p++}`);
    params.push('%' + q.toLowerCase() + '%');
  }

  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  return { where, params };
}

app.get('/api/logs', async (req, res) => {
  const { offset, limit, severity, q, errors } = parseWindowParams(req.query);
  if (errors.length) {
    return res.status(400).json({ error: errors.join('; ') });
  }

  const { where, params } = buildFilter(severity, q);

  try {
    // Total count for the (filtered) corpus so the client can size its
    // virtual scrollbar. Never returns rows themselves.
    const countSql = `SELECT COUNT(*)::int AS total FROM logs ${where};`;
    const countRes = await db.query(countSql, params);
    const total = countRes.rows[0].total;

    // Windowed slice, ordered by ts descending (id as a stable tiebreaker).
    const rowsSql =
      `SELECT id, ts, severity, service, message FROM logs ${where} ` +
      `ORDER BY ts DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2};`;
    const rowsRes = await db.query(rowsSql, [...params, limit, offset]);

    res.json({ total, rows: rowsRes.rows });
  } catch (err) {
    console.error('query error', err);
    res.status(500).json({ error: 'query failed' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const totalRes = await db.query('SELECT COUNT(*)::int AS total FROM logs;');
    const bySevRes = await db.query(
      'SELECT severity, COUNT(*)::int AS count FROM logs GROUP BY severity;'
    );
    const bySeverity = {};
    for (const s of SEVERITIES) bySeverity[s] = 0;
    for (const row of bySevRes.rows) bySeverity[row.severity] = row.count;

    res.json({ total: totalRes.rows[0].total, bySeverity });
  } catch (err) {
    console.error('stats error', err);
    res.status(500).json({ error: 'stats failed' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

async function start() {
  const bootStart = Date.now();
  console.log('Initializing database...');
  const result = await init();
  db = await getDb();
  console.log(
    `Database ready (${result.count} rows, ${result.seeded ? 'seeded' : 'reused'}) in ` +
      `${((Date.now() - bootStart) / 1000).toFixed(1)}s`
  );

  app.listen(PORT, () => {
    console.log(`Log explorer API listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
