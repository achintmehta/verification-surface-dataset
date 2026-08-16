import { Router } from 'express';

/**
 * Normalise a value returned by PGLite so it serialises cleanly to JSON.
 * Dates become ISO strings; BigInts become numbers; everything else passes through.
 */
function normalise(v) {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return Number(v);
  return v;
}

function normaliseRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = normalise(v);
  return out;
}

export function createApiRouter(db) {
  const router = Router();

  // ── GET /api/summary ──────────────────────────────────────────────────────
  // Returns: totalVisitors, totalRevenue, bestDay { date, visitors, revenue },
  //          trend7d (% change of last 7 days vs prior 7 days)
  router.get('/summary', async (_req, res) => {
    try {
      const { rows } = await db.query(`
        SELECT
          SUM(visitors)::BIGINT   AS "totalVisitors",
          SUM(revenue)::BIGINT    AS "totalRevenue",
          MAX(visitors)           AS "maxVisitors"
        FROM daily_metrics
      `);

      const { rows: bestRows } = await db.query(`
        SELECT date, visitors, revenue
        FROM daily_metrics
        ORDER BY visitors DESC
        LIMIT 1
      `);

      // 7-day trend: compare last 7 days vs prior 7 days (by revenue)
      const { rows: trendRows } = await db.query(`
        WITH ordered AS (
          SELECT revenue, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
          FROM daily_metrics
        )
        SELECT
          SUM(CASE WHEN rn <= 7  THEN revenue ELSE 0 END) AS last7,
          SUM(CASE WHEN rn > 7 AND rn <= 14 THEN revenue ELSE 0 END) AS prior7
        FROM ordered
      `);

      const last7 = parseFloat(trendRows[0].last7) || 0;
      const prior7 = parseFloat(trendRows[0].prior7) || 0;
      const trend7d = prior7 === 0 ? 0 : ((last7 - prior7) / prior7) * 100;

      const r = normaliseRow(rows[0]);
      const best = bestRows[0] ? normaliseRow(bestRows[0]) : null;
      res.json({
        totalVisitors: parseInt(r.totalVisitors, 10),
        totalRevenue:  parseInt(r.totalRevenue,  10),
        bestDay: best
          ? {
              // Ensure date is a plain YYYY-MM-DD string
              date:     typeof best.date === 'string' ? best.date.slice(0, 10) : best.date,
              visitors: best.visitors,
              revenue:  best.revenue,
            }
          : null,
        trend7d: Math.round(trend7d * 10) / 10,
      });
    } catch (err) {
      console.error('/api/summary error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/timeseries ───────────────────────────────────────────────────
  router.get('/timeseries', async (_req, res) => {
    try {
      const { rows } = await db.query(`
        SELECT date, visitors, revenue
        FROM daily_metrics
        ORDER BY date ASC
      `);
      // Normalise dates to plain YYYY-MM-DD strings
      const normalised = rows.map((row) => {
        const r = normaliseRow(row);
        return { ...r, date: typeof r.date === 'string' ? r.date.slice(0, 10) : r.date };
      });
      res.json(normalised);
    } catch (err) {
      console.error('/api/timeseries error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/categories ───────────────────────────────────────────────────
  router.get('/categories', async (_req, res) => {
    try {
      const { rows } = await db.query(`
        SELECT name, value
        FROM categories
        ORDER BY value DESC
      `);
      res.json(rows.map(normaliseRow));
    } catch (err) {
      console.error('/api/categories error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/recent ───────────────────────────────────────────────────────
  router.get('/recent', async (_req, res) => {
    try {
      const { rows } = await db.query(`
        SELECT id, name, category, value, created_at
        FROM recent_items
        ORDER BY created_at DESC
        LIMIT 20
      `);
      res.json(rows.map(normaliseRow));
    } catch (err) {
      console.error('/api/recent error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/settings ─────────────────────────────────────────────────────
  router.get('/settings', async (_req, res) => {
    try {
      const { rows } = await db.query(
        "SELECT value FROM settings WHERE key = 'theme'",
      );
      const theme = rows[0]?.value ?? 'light';
      res.json({ theme });
    } catch (err) {
      console.error('/api/settings GET error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── PUT /api/settings ─────────────────────────────────────────────────────
  router.put('/settings', async (req, res) => {
    try {
      const { theme } = req.body;
      if (theme !== 'light' && theme !== 'dark') {
        return res.status(400).json({ error: 'theme must be "light" or "dark"' });
      }
      await db.query(
        "INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
        [theme],
      );
      res.json({ theme });
    } catch (err) {
      console.error('/api/settings PUT error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
