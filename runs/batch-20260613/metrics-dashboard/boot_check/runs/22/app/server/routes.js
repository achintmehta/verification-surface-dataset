const { Router } = require('express');

module.exports = function apiRoutes(db) {
  const router = Router();

  // GET /api/summary - four headline numbers
  router.get('/summary', async (req, res) => {
    try {
      const totalVisitors = await db.query('SELECT COALESCE(SUM(visitors), 0) AS total FROM daily_metrics');
      const totalRevenue = await db.query('SELECT COALESCE(SUM(revenue), 0) AS total FROM daily_metrics');
      const bestDay = await db.query('SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1');

      // 7-day trend %: compare last 7 days avg to previous 7 days avg
      const trend = await db.query(`
        WITH ranked AS (
          SELECT visitors, date,
                 ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
          FROM daily_metrics
        ),
        recent AS (SELECT AVG(visitors) AS avg_v FROM ranked WHERE rn <= 7),
        previous AS (SELECT AVG(visitors) AS avg_v FROM ranked WHERE rn > 7 AND rn <= 14)
        SELECT
          recent.avg_v AS recent_avg,
          previous.avg_v AS prev_avg,
          CASE WHEN previous.avg_v > 0
            THEN ROUND(((recent.avg_v - previous.avg_v) / previous.avg_v * 100)::numeric, 1)
            ELSE 0
          END AS trend_pct
        FROM recent, previous
      `);

      res.json({
        totalVisitors: Number(totalVisitors.rows[0].total),
        totalRevenue: Number(totalRevenue.rows[0].total),
        bestDay: bestDay.rows[0] ? {
          date: bestDay.rows[0].date,
          visitors: Number(bestDay.rows[0].visitors)
        } : null,
        trendPercent: Number(trend.rows[0]?.trend_pct || 0)
      });
    } catch (err) {
      console.error('Error in /api/summary:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/timeseries
  router.get('/timeseries', async (req, res) => {
    try {
      const result = await db.query('SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC');
      res.json(result.rows.map(r => ({
        date: r.date,
        visitors: Number(r.visitors),
        revenue: Number(r.revenue)
      })));
    } catch (err) {
      console.error('Error in /api/timeseries:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/categories
  router.get('/categories', async (req, res) => {
    try {
      const result = await db.query('SELECT name, value FROM categories ORDER BY value DESC');
      res.json(result.rows.map(r => ({
        name: r.name,
        value: Number(r.value)
      })));
    } catch (err) {
      console.error('Error in /api/categories:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/recent
  router.get('/recent', async (req, res) => {
    try {
      const result = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC');
      res.json(result.rows.map(r => ({
        name: r.name,
        category: r.category,
        value: Number(r.value),
        createdAt: r.created_at
      })));
    } catch (err) {
      console.error('Error in /api/recent:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/settings
  router.get('/settings', async (req, res) => {
    try {
      const result = await db.query("SELECT value FROM settings WHERE key = 'theme'");
      const theme = result.rows[0]?.value || 'light';
      res.json({ theme });
    } catch (err) {
      console.error('Error in GET /api/settings:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PUT /api/settings
  router.put('/settings', async (req, res) => {
    try {
      const { theme } = req.body;
      if (!theme || !['light', 'dark'].includes(theme)) {
        return res.status(400).json({ error: 'theme must be "light" or "dark"' });
      }
      await db.query(
        "UPDATE settings SET value = $1 WHERE key = 'theme'",
        [theme]
      );
      res.json({ theme });
    } catch (err) {
      console.error('Error in PUT /api/settings:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};
