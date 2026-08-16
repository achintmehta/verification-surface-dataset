import express from 'express';
import cors from 'cors';
import { getDb, seedIfNeeded, SEVERITIES } from './db.js';

const PORT = process.env.PORT || 3001;
const MAX_LIMIT = 200;

const app = express();
app.use(cors());
app.use(express.json());

/**
 * GET /api/logs?offset=&limit=&severity=&q=
 * Returns { total, rows } ordered by ts DESC.
 */
app.get('/api/logs', async (req, res) => {
  const { offset: rawOffset, limit: rawLimit, severity, q } = req.query;

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
    if (!Number.isInteger(limit) || limit < 0) {
      return res.status(400).json({ error: 'limit must be a non-negative integer' });
    }
    if (limit > MAX_LIMIT) {
      return res.status(400).json({ error: `limit must not exceed ${MAX_LIMIT}` });
    }
  }

  // Validate severity.
  if (severity !== undefined && severity !== '' && !SEVERITIES.includes(severity)) {
    return res.status(400).json({ error: `severity must be one of ${SEVERITIES.join(', ')}` });
  }

  const clauses = [];
  const params = [];
  let p = 1;

  if (severity !== undefined && severity !== '') {
    clauses.push(`severity = $${p++}`);
    params.push(severity);
  }

  if (q !== undefined && q !== '') {
    clauses.push(`lower(message) LIKE $${p++}`);
    // Escape LIKE metacharacters and search case-insensitively.
    const esc = String(q).toLowerCase().replace(/([%_\\])/g, '\\$1');
    params.push(`%${esc}%`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  try {
    const db = await getDb();

    const totalRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM logs ${where};`,
      params
    );
    const total = totalRes.rows[0].total;

    const rowParams = params.slice();
    const rowsRes = await db.query(
      `SELECT id, ts, severity, service, message
       FROM logs
       ${where}
       ORDER BY ts DESC, id DESC
       LIMIT $${p++} OFFSET $${p++};`,
      [...rowParams, limit, offset]
    );

    res.json({ total, rows: rowsRes.rows });
  } catch (err) {
    console.error('[api/logs] error', err);
    res.status(500).json({ error: 'internal error' });
  }
});

/**
 * GET /api/stats -> total + per-severity counts.
 */
app.get('/api/stats', async (_req, res) => {
  try {
    const db = await getDb();
    const totalRes = await db.query('SELECT COUNT(*)::int AS total FROM logs;');
    const bySevRes = await db.query(
      'SELECT severity, COUNT(*)::int AS count FROM logs GROUP BY severity;'
    );
    const bySeverity = {};
    for (const s of SEVERITIES) bySeverity[s] = 0;
    for (const row of bySevRes.rows) bySeverity[row.severity] = row.count;
    res.json({ total: totalRes.rows[0].total, bySeverity });
  } catch (err) {
    console.error('[api/stats] error', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

async function main() {
  const bootStart = Date.now();
  await seedIfNeeded();
  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT} (boot ${Date.now() - bootStart}ms)`);
  });
}

main().catch((err) => {
  console.error('[server] fatal', err);
  process.exit(1);
});
