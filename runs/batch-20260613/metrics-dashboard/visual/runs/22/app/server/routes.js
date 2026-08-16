const { Router } = require('express');

function apiRoutes(db) {
  const router = Router();

  // GET /api/summary - four headline numbers
  router.get('/summary', async (req, res) => {
    try {
      // Total visitors
      const visitorsRes = await db.query('SELECT COALESCE(SUM(visitors), 0) as total_visitors FROM daily_metrics');
      const totalVisitors = parseInt(visitorsRes.rows[0].total_visitors);

      // Total revenue
      const revenueRes = await db.query('SELECT COALESCE(SUM(revenue), 0) as total_revenue FROM daily_metrics');
      const totalRevenue = parseFloat(revenueRes.rows[0].total_revenue);

      // Best day (by visitors)
      const bestDayRes = await db.query('SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1');
      const bestDay = bestDayRes.rows[0] ? { date: bestDayRes.rows[0].date, visitors: parseInt(bestDayRes.rows[0].visitors) } : null;

      // 7-day trend % (last 7 days avg vs previous 7 days avg, by revenue)
      const last7Res = await db.query(`
        SELECT COALESCE(AVG(revenue), 0) as avg_revenue
        FROM daily_metrics
        WHERE date > (SELECT MAX(date) - INTERVAL '7 days' FROM daily_metrics)
      `);
      const prev7Res = await db.query(`
        SELECT COALESCE(AVG(revenue), 0) as avg_revenue
        FROM daily_metrics
        WHERE date <= (SELECT MAX(date) - INTERVAL '7 days' FROM daily_metrics)
          AND date > (SELECT MAX(date) - INTERVAL '14 days' FROM daily_metrics)
      `);
      const last7Avg = parseFloat(last7Res.rows[0].avg_revenue);
      const prev7Avg = parseFloat(prev7Res.rows[0].avg_revenue);
      const trend = prev7Avg > 0 ? (((last7Avg - prev7Avg) / prev7Avg) * 100) : 0;

      res.json({
        totalVisitors,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        bestDay,
        trend: Math.round(trend * 100) / 100
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
        visitors: parseInt(r.visitors),
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
        value: parseInt(r.value)
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

module.exports = apiRoutes;
