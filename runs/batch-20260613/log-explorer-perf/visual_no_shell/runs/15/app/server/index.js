import express from 'express';
import cors from 'cors';
import { getDb, SEVERITIES } from './db.js';

const PORT = process.env.PORT || 3001;
const MAX_LIMIT = 200;

async function main() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  console.log('[server] initializing database (seeds on first boot)...');
  const bootStart = Date.now();
  const db = await getDb();
  console.log(`[server] database ready in ${Date.now() - bootStart}ms`);

  // ---------------------------------------------------------------------------
  // GET /api/logs?offset=&limit=&severity=&q=
  // ---------------------------------------------------------------------------
  app.get('/api/logs', async (req, res) => {
    const { offset, limit, severity, q } = req.query;

    // Validate offset.
    let off = 0;
    if (offset !== undefined) {
      off = Number(offset);
      if (!Number.isInteger(off) || off < 0) {
        return res.status(400).json({ error: 'offset must be a non-negative integer' });
      }
    }

    // Validate limit.
    let lim = 100;
    if (limit !== undefined) {
      lim = Number(limit);
      if (!Number.isInteger(lim) || lim < 1) {
        return res.status(400).json({ error: 'limit must be a positive integer' });
      }
      if (lim > MAX_LIMIT) {
        return res.status(400).json({ error: `limit must not exceed ${MAX_LIMIT}` });
      }
    }

    // Validate severity.
    let sev = null;
    if (severity !== undefined && severity !== '') {
      if (!SEVERITIES.includes(severity)) {
        return res.status(400).json({ error: 'unknown severity' });
      }
      sev = severity;
    }

    // Substring term.
    let term = null;
    if (q !== undefined && String(q).trim() !== '') {
      term = String(q).trim();
    }

    try {
      const where = [];
      const params = [];
      let p = 0;
      if (sev) {
        params.push(sev);
        where.push(`severity = $${++p}`);
      }
      if (term) {
        params.push('%' + term.toLowerCase() + '%');
        where.push(`lower(message) LIKE $${++p}`);
      }
      const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

      // Total count for this filter combination.
      const countSql = `SELECT COUNT(*)::int AS total FROM logs ${whereClause};`;
      const countRes = await db.query(countSql, params);
      const total = countRes.rows[0].total;

      // Windowed rows.
      const rowsParams = params.slice();
      rowsParams.push(lim);
      const limIdx = ++p;
      rowsParams.push(off);
      const offIdx = ++p;
      const rowsSql = `
        SELECT id, ts, severity, service, message
        FROM logs
        ${whereClause}
        ORDER BY ts DESC, id DESC
        LIMIT $${limIdx} OFFSET $${offIdx};
      `;
      const rowsRes = await db.query(rowsSql, rowsParams);

      res.json({ total, rows: rowsRes.rows });
    } catch (e) {
      console.error('[api/logs] error', e);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/stats
  // ---------------------------------------------------------------------------
  app.get('/api/stats', async (_req, res) => {
    try {
      const totalRes = await db.query('SELECT COUNT(*)::int AS total FROM logs;');
      const bySevRes = await db.query(
        'SELECT severity, COUNT(*)::int AS c FROM logs GROUP BY severity;'
      );
      const bySeverity = {};
      for (const s of SEVERITIES) bySeverity[s] = 0;
      for (const r of bySevRes.rows) bySeverity[r.severity] = r.c;
      res.json({ total: totalRes.rows[0].total, bySeverity });
    } catch (e) {
      console.error('[api/stats] error', e);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});
