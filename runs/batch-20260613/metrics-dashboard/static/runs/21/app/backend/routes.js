function createRoutes(app, db) {
  // GET /api/summary - four headline numbers
  app.get('/api/summary', async (_req, res) => {
    try {
      const totalVisitors = await db.query(`SELECT COALESCE(SUM(visitors), 0) AS total FROM daily_metrics`);
      const totalRevenue = await db.query(`SELECT COALESCE(SUM(revenue), 0) AS total FROM daily_metrics`);
      const bestDay = await db.query(`SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1`);

      // 7-day trend: compare last 7 days average vs previous 7 days average
      const trendResult = await db.query(`
        WITH ranked AS (
          SELECT visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
          FROM daily_metrics
        ),
        recent AS (SELECT AVG(visitors) AS avg FROM ranked WHERE rn <= 7),
        previous AS (SELECT AVG(visitors) AS avg FROM ranked WHERE rn > 7 AND rn <= 14)
        SELECT
          recent.avg AS recent_avg,
          previous.avg AS previous_avg,
          CASE WHEN previous.avg > 0
            THEN ROUND(((recent.avg - previous.avg) / previous.avg * 100)::numeric, 1)
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
        trendPercent: Number(trendResult.rows[0].trend_pct),
      });
    } catch (err) {
      console.error('Error in /api/summary:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/timeseries
  app.get('/api/timeseries', async (_req, res) => {
    try {
      const result = await db.query(`
        SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC
      `);
      res.json(result.rows.map(r => ({
        date: r.date,
        visitors: Number(r.visitors),
        revenue: Number(r.revenue),
      })));
    } catch (err) {
      console.error('Error in /api/timeseries:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/categories
  app.get('/api/categories', async (_req, res) => {
    try {
      const result = await db.query(`SELECT name, value FROM categories ORDER BY value DESC`);
      res.json(result.rows.map(r => ({
        name: r.name,
        value: Number(r.value),
      })));
    } catch (err) {
      console.error('Error in /api/categories:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/recent
  app.get('/api/recent', async (_req, res) => {
    try {
      const result = await db.query(`
        SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC
      `);
      res.json(result.rows.map(r => ({
        name: r.name,
        category: r.category,
        value: Number(r.value),
        createdAt: r.created_at,
      })));
    } catch (err) {
      console.error('Error in /api/recent:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/settings
  app.get('/api/settings', async (_req, res) => {
    try {
      const result = await db.query(`SELECT value FROM settings WHERE key = 'theme'`);
      const theme = result.rows.length > 0 ? result.rows[0].value : 'light';
      res.json({ theme });
    } catch (err) {
      console.error('Error in GET /api/settings:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PUT /api/settings
  app.put('/api/settings', async (req, res) => {
    try {
      const { theme } = req.body;
      if (!theme || !['light', 'dark'].includes(theme)) {
        return res.status(400).json({ error: 'theme must be "light" or "dark"' });
      }

      // Upsert
      await db.query(`
        INSERT INTO settings (key, value) VALUES ('theme', $1)
        ON CONFLICT (key) DO UPDATE SET value = $1
      `, [theme]);

      res.json({ theme });
    } catch (err) {
      console.error('Error in PUT /api/settings:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}

module.exports = { createRoutes };
