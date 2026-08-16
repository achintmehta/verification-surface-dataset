import { Router } from 'express';

export function createApiRouter(db) {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /api/summary
  // Returns: { totalVisitors, totalRevenue, bestDay, trendPct }
  // -------------------------------------------------------------------------
  router.get('/summary', async (_req, res) => {
    try {
      // Total visitors & revenue
      const totals = await db.query(`
        SELECT
          SUM(visitors)::BIGINT   AS "totalVisitors",
          SUM(revenue)::NUMERIC   AS "totalRevenue"
        FROM daily_metrics
      `);

      // Best day by visitors
      const best = await db.query(`
        SELECT date, visitors
        FROM daily_metrics
        ORDER BY visitors DESC
        LIMIT 1
      `);

      // 7-day trend: compare last 7 days vs prior 7 days (by visitors)
      const trend = await db.query(`
        WITH ordered AS (
          SELECT visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
          FROM daily_metrics
        ),
        last7   AS (SELECT AVG(visitors) AS avg FROM ordered WHERE rn <= 7),
        prior7  AS (SELECT AVG(visitors) AS avg FROM ordered WHERE rn > 7 AND rn <= 14)
        SELECT
          CASE
            WHEN prior7.avg = 0 OR prior7.avg IS NULL THEN 0
            ELSE ROUND(((last7.avg - prior7.avg) / prior7.avg) * 100, 1)
          END AS "trendPct"
        FROM last7, prior7
      `);

      const row = totals.rows[0];
      const bestRow = best.rows[0];
      const trendRow = trend.rows[0];

      res.json({
        totalVisitors: Number(row.totalVisitors),
        totalRevenue:  Number(row.totalRevenue),
        bestDay: bestRow
          ? { date: bestRow.date, visitors: Number(bestRow.visitors) }
          : null,
        trendPct: trendRow ? Number(trendRow.trendPct) : 0,
      });
    } catch (err) {
      console.error('/api/summary error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/timeseries
  // Returns: [{ date, visitors, revenue }]
  // -------------------------------------------------------------------------
  router.get('/timeseries', async (_req, res) => {
    try {
      const result = await db.query(`
        SELECT date, visitors, revenue::FLOAT AS revenue
        FROM daily_metrics
        ORDER BY date ASC
      `);
      res.json(
        result.rows.map((r) => ({
          date:     r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date),
          visitors: Number(r.visitors),
          revenue:  Number(r.revenue),
        }))
      );
    } catch (err) {
      console.error('/api/timeseries error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/categories
  // Returns: [{ name, value }] sorted by value desc
  // -------------------------------------------------------------------------
  router.get('/categories', async (_req, res) => {
    try {
      const result = await db.query(`
        SELECT name, value::FLOAT AS value
        FROM categories
        ORDER BY value DESC
      `);
      res.json(
        result.rows.map((r) => ({
          name:  r.name,
          value: Number(r.value),
        }))
      );
    } catch (err) {
      console.error('/api/categories error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/recent
  // Returns: [{ id, name, category, value, createdAt }] most recent 20
  // -------------------------------------------------------------------------
  router.get('/recent', async (_req, res) => {
    try {
      const result = await db.query(`
        SELECT id, name, category, value::FLOAT AS value, created_at
        FROM recent_items
        ORDER BY created_at DESC
        LIMIT 20
      `);
      res.json(
        result.rows.map((r) => ({
          id:        Number(r.id),
          name:      r.name,
          category:  r.category,
          value:     Number(r.value),
          createdAt: r.created_at instanceof Date
            ? r.created_at.toISOString()
            : String(r.created_at),
        }))
      );
    } catch (err) {
      console.error('/api/recent error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/settings
  // Returns: { theme: "light" | "dark" }
  // -------------------------------------------------------------------------
  router.get('/settings', async (_req, res) => {
    try {
      const result = await db.query(
        "SELECT value FROM settings WHERE key = 'theme' LIMIT 1"
      );
      const theme = result.rows.length > 0 ? result.rows[0].value : 'light';
      res.json({ theme });
    } catch (err) {
      console.error('/api/settings GET error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // PUT /api/settings
  // Body: { theme: "light" | "dark" }
  // -------------------------------------------------------------------------
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
