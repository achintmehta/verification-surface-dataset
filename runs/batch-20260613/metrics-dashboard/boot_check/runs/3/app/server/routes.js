import { Router } from 'express';

export function createApiRouter(db) {
  const router = Router();

  // ── GET /api/summary ──────────────────────────────────────────────────────
  router.get('/summary', async (req, res) => {
    try {
      // Total visitors and total revenue across all 30 days
      const { rows: totals } = await db.query(`
        SELECT
          SUM(visitors)::BIGINT          AS total_visitors,
          SUM(revenue)::NUMERIC(14,2)    AS total_revenue
        FROM daily_metrics
      `);

      // Best single day by visitors
      const { rows: bestRows } = await db.query(`
        SELECT date, visitors
        FROM daily_metrics
        ORDER BY visitors DESC
        LIMIT 1
      `);

      // 7-day trend: compare last 7 days vs previous 7 days (by visitors)
      const { rows: trendRows } = await db.query(`
        WITH ordered AS (
          SELECT visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
          FROM daily_metrics
        ),
        last7   AS (SELECT SUM(visitors) AS s FROM ordered WHERE rn <= 7),
        prev7   AS (SELECT SUM(visitors) AS s FROM ordered WHERE rn > 7 AND rn <= 14)
        SELECT
          last7.s AS last_7,
          prev7.s AS prev_7
        FROM last7, prev7
      `);

      const last7 = parseFloat(trendRows[0]?.last_7 || 0);
      const prev7 = parseFloat(trendRows[0]?.prev_7 || 0);
      const trendPct =
        prev7 === 0 ? 0 : (((last7 - prev7) / prev7) * 100).toFixed(1);

      res.json({
        total_visitors: parseInt(totals[0].total_visitors, 10),
        total_revenue: parseFloat(totals[0].total_revenue),
        best_day: {
          date: bestRows[0]?.date,
          visitors: parseInt(bestRows[0]?.visitors, 10),
        },
        trend_7d_pct: parseFloat(trendPct),
      });
    } catch (err) {
      console.error('/api/summary error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/timeseries ───────────────────────────────────────────────────
  router.get('/timeseries', async (req, res) => {
    try {
      const { rows } = await db.query(`
        SELECT date, visitors, revenue::FLOAT AS revenue
        FROM daily_metrics
        ORDER BY date ASC
      `);
      res.json(rows);
    } catch (err) {
      console.error('/api/timeseries error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/categories ───────────────────────────────────────────────────
  router.get('/categories', async (req, res) => {
    try {
      const { rows } = await db.query(`
        SELECT name, value::BIGINT AS value
        FROM categories
        ORDER BY value DESC
      `);
      res.json(rows);
    } catch (err) {
      console.error('/api/categories error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/recent ───────────────────────────────────────────────────────
  router.get('/recent', async (req, res) => {
    try {
      const { rows } = await db.query(`
        SELECT id, name, category, value::FLOAT AS value, created_at
        FROM recent_items
        ORDER BY created_at DESC
        LIMIT 20
      `);
      res.json(rows);
    } catch (err) {
      console.error('/api/recent error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/settings ─────────────────────────────────────────────────────
  router.get('/settings', async (req, res) => {
    try {
      const { rows } = await db.query(
        "SELECT value FROM settings WHERE key = 'theme'"
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
        [theme]
      );
      res.json({ theme });
    } catch (err) {
      console.error('/api/settings PUT error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
