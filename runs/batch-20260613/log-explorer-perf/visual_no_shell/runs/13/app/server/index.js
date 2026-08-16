import express from 'express';
import cors from 'cors';
import { getDb, SEVERITIES } from './db.js';

const PORT = process.env.PORT || 3001;
const MAX_LIMIT = 200;

// Small LRU-ish cache for filtered total counts. The corpus is static, so a
// (severity, q) -> total mapping is stable and lets deep-offset scrolling
// within the same filter avoid re-scanning for COUNT on every window.
const countCache = new Map();
const COUNT_CACHE_MAX = 200;
function cacheGet(key) {
  if (!countCache.has(key)) return undefined;
  const v = countCache.get(key);
  countCache.delete(key);
  countCache.set(key, v); // move to newest
  return v;
}
function cacheSet(key, val) {
  countCache.set(key, val);
  if (countCache.size > COUNT_CACHE_MAX) {
    countCache.delete(countCache.keys().next().value);
  }
}

async function main() {
  const bootStart = Date.now();
  const db = await getDb();
  console.log(`DB ready in ${Date.now() - bootStart}ms.`);

  const app = express();
  app.use(cors());
  app.use(express.json());

  // GET /api/logs?offset=&limit=&severity=&q=
  app.get('/api/logs', async (req, res) => {
    const { offset, limit, severity, q } = req.query;

    // --- validate offset ---
    let off = 0;
    if (offset !== undefined) {
      off = Number(offset);
      if (!Number.isInteger(off) || off < 0) {
        return res.status(400).json({ error: 'offset must be a non-negative integer' });
      }
    }

    // --- validate limit ---
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

    // --- validate severity ---
    let sev = null;
    if (severity !== undefined && severity !== '') {
      if (!SEVERITIES.includes(severity)) {
        return res.status(400).json({ error: 'unknown severity' });
      }
      sev = severity;
    }

    // --- q (substring) ---
    const term = typeof q === 'string' && q.length > 0 ? q : null;

    // Build WHERE clause.
    const conds = [];
    const params = [];
    let p = 0;
    if (sev) {
      conds.push(`severity = $${++p}`);
      params.push(sev);
    }
    if (term) {
      conds.push(`lower(message) LIKE $${++p}`);
      params.push('%' + term.toLowerCase() + '%');
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    try {
      const t0 = Date.now();
      const cacheKey = `${sev || ''}\u0000${term || ''}`;
      let total = cacheGet(cacheKey);
      if (total === undefined) {
        const totalRes = await db.query(
          `SELECT COUNT(*)::int AS c FROM logs ${where};`,
          params
        );
        total = totalRes.rows[0].c;
        cacheSet(cacheKey, total);
      }

      const rowsRes = await db.query(
        `SELECT id, ts, severity, service, message
         FROM logs ${where}
         ORDER BY ts DESC, id DESC
         LIMIT $${++p} OFFSET $${++p};`,
        [...params, lim, off]
      );

      const dt = Date.now() - t0;
      if (dt > 100) {
        console.log(`[slow] /api/logs off=${off} lim=${lim} sev=${sev || '-'} q=${term || '-'} -> ${dt}ms (${total} total)`);
      }
      res.json({ total, rows: rowsRes.rows });
    } catch (e) {
      console.error('query error', e);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // GET /api/stats
  app.get('/api/stats', async (_req, res) => {
    try {
      const totalRes = await db.query(`SELECT COUNT(*)::int AS c FROM logs;`);
      const bySevRes = await db.query(
        `SELECT severity, COUNT(*)::int AS c FROM logs GROUP BY severity;`
      );
      const bySeverity = {};
      for (const s of SEVERITIES) bySeverity[s] = 0;
      for (const row of bySevRes.rows) bySeverity[row.severity] = row.c;
      res.json({ total: totalRes.rows[0].c, bySeverity });
    } catch (e) {
      console.error('stats error', e);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.listen(PORT, () => {
    console.log(`Log explorer API listening on http://localhost:${PORT}`);
    console.log(`Total boot time: ${Date.now() - bootStart}ms`);
  });
}

main().catch((e) => {
  console.error('Fatal boot error:', e);
  process.exit(1);
});
