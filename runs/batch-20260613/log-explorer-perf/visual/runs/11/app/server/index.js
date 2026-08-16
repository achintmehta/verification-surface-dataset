import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { getDb, initDb, SEVERITIES } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const MAX_LIMIT = 200;

const app = express();
app.use(cors());
app.use(express.json());

// In production, serve the built client (dist/) so a single process serves
// both the API and the static UI. In dev, use `npm run dev` (Vite proxies /api).
const DIST_DIR = path.join(__dirname, '..', 'dist');
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
}

function parseIntStrict(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!/^-?\d+$/.test(String(value))) return NaN;
  return parseInt(value, 10);
}

// Build WHERE clause + params for the given filters.
function buildFilter(severity, q) {
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
  const offset = parseIntStrict(req.query.offset ?? '0');
  const limit = parseIntStrict(req.query.limit ?? '100');
  const severity = req.query.severity ? String(req.query.severity) : '';
  const q = req.query.q ? String(req.query.q) : '';

  // Validation.
  if (offset === null || Number.isNaN(offset) || offset < 0) {
    return res.status(400).json({ error: 'invalid offset' });
  }
  if (limit === null || Number.isNaN(limit) || limit < 1 || limit > MAX_LIMIT) {
    return res.status(400).json({ error: `invalid limit (1..${MAX_LIMIT})` });
  }
  if (severity && !SEVERITIES.includes(severity)) {
    return res.status(400).json({ error: 'unknown severity' });
  }

  try {
    const db = await getDb();
    const { where, params } = buildFilter(severity, q);

    const countSql = `SELECT COUNT(*)::int AS total FROM logs ${where};`;
    const countRes = await db.query(countSql, params);
    const total = countRes.rows[0].total;

    const rowsSql = `
      SELECT id, ts, severity, service, message
      FROM logs
      ${where}
      ORDER BY ts DESC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2};
    `;
    const rowsRes = await db.query(rowsSql, [...params, limit, offset]);

    res.json({ total, rows: rowsRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/stats', async (_req, res) => {
  try {
    const db = await getDb();
    const totalRes = await db.query('SELECT COUNT(*)::int AS total FROM logs;');
    const bySevRes = await db.query(`
      SELECT severity, COUNT(*)::int AS c
      FROM logs
      GROUP BY severity;
    `);
    const bySeverity = {};
    for (const s of SEVERITIES) bySeverity[s] = 0;
    for (const row of bySevRes.rows) bySeverity[row.severity] = row.c;
    res.json({ total: totalRes.rows[0].total, bySeverity });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// SPA fallback for any non-API route (only when a build exists).
app.get(/^\/(?!api\/).*/, (_req, res, next) => {
  const indexPath = path.join(DIST_DIR, 'index.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  next();
});

async function main() {
  const bootStart = Date.now();
  console.log('Initializing database (seeding on first boot only)...');
  await initDb();
  console.log(`Database ready in ${((Date.now() - bootStart) / 1000).toFixed(1)}s`);

  app.listen(PORT, () => {
    console.log(`Log explorer API listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
