export function createRoutes(app, db) {
  // GET /api/summary - four headline numbers
  app.get('/api/summary', async (req, res) => {
    try {
      const totalVisitors = await db.query(`SELECT COALESCE(SUM(visitors), 0) AS total FROM daily_metrics`);
      const totalRevenue = await db.query(`SELECT COALESCE(SUM(revenue), 0) AS total FROM daily_metrics`);
      const bestDay = await db.query(`SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1`);

      // 7-day trend: compare last 7 days avg to previous 7 days avg
      const recent7 = await db.query(`
        SELECT COALESCE(AVG(visitors), 0) AS avg_visitors
        FROM (SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 7) sub
      `);
      const prev7 = await db.query(`
        SELECT COALESCE(AVG(visitors), 0) AS avg_visitors
        FROM (SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 14 OFFSET 7) sub
      `);

      const recentAvg = parseFloat(recent7.rows[0].avg_visitors);
      const prevAvg = parseFloat(prev7.rows[0].avg_visitors);
      const trend = prevAvg === 0 ? 0 : ((recentAvg - prevAvg) / prevAvg * 100);

      res.json({
        totalVisitors: parseInt(totalVisitors.rows[0].total),
        totalRevenue: parseFloat(totalRevenue.rows[0].total),
        bestDay: bestDay.rows[0] ? { date: bestDay.rows[0].date, visitors: bestDay.rows[0].visitors } : null,
        trend7d: parseFloat(trend.toFixed(2))
      });
    } catch (err) {
      console.error('Error in /api/summary:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/timeseries
  app.get('/api/timeseries', async (req, res) => {
    try {
      const result = await db.query(`SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC`);
      res.json(result.rows);
    } catch (err) {
      console.error('Error in /api/timeseries:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/categories
  app.get('/api/categories', async (req, res) => {
    try {
      const result = await db.query(`SELECT name, value FROM categories ORDER BY value DESC`);
      res.json(result.rows);
    } catch (err) {
      console.error('Error in /api/categories:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/recent
  app.get('/api/recent', async (req, res) => {
    try {
      const result = await db.query(`SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC`);
      res.json(result.rows);
    } catch (err) {
      console.error('Error in /api/recent:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/settings
  app.get('/api/settings', async (req, res) => {
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
        return res.status(400).json({ error: 'Invalid theme. Must be "light" or "dark".' });
      }
      await db.query(`UPDATE settings SET value = $1 WHERE key = 'theme'`, [theme]);
      res.json({ theme });
    } catch (err) {
      console.error('Error in PUT /api/settings:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
