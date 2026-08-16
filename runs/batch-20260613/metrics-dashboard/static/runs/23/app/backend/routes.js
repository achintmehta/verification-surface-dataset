const express = require('express');

function createApiRoutes(db) {
  const router = express.Router();

  // GET /api/summary
  // Returns: { totalVisitors, totalRevenue, bestDay, sevenDayTrend }
  router.get('/summary', async (req, res) => {
    try {
      const totalVisitors = await db.query('SELECT COALESCE(SUM(visitors), 0) AS total FROM daily_metrics');
      const totalRevenue = await db.query('SELECT COALESCE(SUM(revenue), 0) AS total FROM daily_metrics');

      const bestDay = await db.query(
        'SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1'
      );

      // 7-day trend: compare last 7 days avg to previous 7 days avg
      const trend = await db.query(`
        WITH ordered AS (
          SELECT visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
          FROM daily_metrics
        ),
        recent AS (
          SELECT AVG(visitors) AS avg_val FROM ordered WHERE rn <= 7
        ),
        previous AS (
          SELECT AVG(visitors) AS avg_val FROM ordered WHERE rn > 7 AND rn <= 14
        )
        SELECT
          recent.avg_val AS recent_avg,
          previous.avg_val AS previous_avg,
          CASE
            WHEN previous.avg_val = 0 THEN 0
            ELSE ROUND(((recent.avg_val - previous.avg_val) / previous.avg_val) * 100, 1)
          END AS trend_pct
        FROM recent, previous
      `);

      res.json({
        totalVisitors: parseInt(totalVisitors.rows[0].total, 10),
        totalRevenue: parseFloat(totalRevenue.rows[0].total),
        bestDay: bestDay.rows[0] ? {
          date: bestDay.rows[0].date,
          visitors: parseInt(bestDay.rows[0].visitors, 10)
        } : null,
        sevenDayTrend: trend.rows[0] ? parseFloat(trend.rows[0].trend_pct) : 0
      });
    } catch (err) {
      console.error('Error in /api/summary:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/timeseries
  router.get('/timeseries', async (req, res) => {
    try {
      const result = await db.query(
        'SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC'
      );
      res.json(result.rows.map(r => ({
        date: r.date,
        visitors: parseInt(r.visitors, 10),
        revenue: parseFloat(r.revenue)
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
        value: parseInt(r.value, 10)
      })));
    } catch (err) {
      console.error('Error in /api/categories:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/recent
  router.get('/recent', async (req, res) => {
    try {
      const result = await db.query(
        'SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC'
      );
      res.json(result.rows.map(r => ({
        name: r.name,
        category: r.category,
        value: parseFloat(r.value),
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
      const theme = result.rows.length > 0 ? result.rows[0].value : 'light';
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
        "INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
        [theme]
      );
      res.json({ theme });
    } catch (err) {
      console.error('Error in PUT /api/settings:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { createApiRoutes };
