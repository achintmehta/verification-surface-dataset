import { Router } from 'express';

export function createApiRoutes(db) {
  const router = Router();

  // GET /api/summary - four headline numbers
  router.get('/summary', async (req, res) => {
    try {
      const totalVisitors = await db.query(
        `SELECT COALESCE(SUM(visitors), 0) as total FROM daily_metrics`
      );
      const totalRevenue = await db.query(
        `SELECT COALESCE(SUM(revenue), 0) as total FROM daily_metrics`
      );
      const bestDay = await db.query(
        `SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1`
      );

      // 7-day trend: compare last 7 days avg to previous 7 days avg
      const last7 = await db.query(
        `SELECT COALESCE(AVG(visitors), 0) as avg FROM (
          SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 7
        ) sub`
      );
      const prev7 = await db.query(
        `SELECT COALESCE(AVG(visitors), 0) as avg FROM (
          SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 7 OFFSET 7
        ) sub`
      );

      const last7Avg = parseFloat(last7.rows[0].avg);
      const prev7Avg = parseFloat(prev7.rows[0].avg);
      const trendPct = prev7Avg === 0 ? 0 : ((last7Avg - prev7Avg) / prev7Avg * 100);

      res.json({
        totalVisitors: parseInt(totalVisitors.rows[0].total),
        totalRevenue: parseFloat(totalRevenue.rows[0].total),
        bestDay: {
          date: bestDay.rows[0].date,
          visitors: bestDay.rows[0].visitors
        },
        trendPct: Math.round(trendPct * 100) / 100
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
        `SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC`
      );
      res.json(result.rows);
    } catch (err) {
      console.error('Error in /api/timeseries:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/categories
  router.get('/categories', async (req, res) => {
    try {
      const result = await db.query(
        `SELECT name, value FROM categories ORDER BY value DESC`
      );
      res.json(result.rows);
    } catch (err) {
      console.error('Error in /api/categories:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/recent
  router.get('/recent', async (req, res) => {
    try {
      const result = await db.query(
        `SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC`
      );
      res.json(result.rows);
    } catch (err) {
      console.error('Error in /api/recent:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/settings
  router.get('/settings', async (req, res) => {
    try {
      const result = await db.query(
        `SELECT key, value FROM settings`
      );
      const settings = {};
      for (const row of result.rows) {
        settings[row.key] = row.value;
      }
      res.json(settings);
    } catch (err) {
      console.error('Error in GET /api/settings:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PUT /api/settings
  router.put('/settings', async (req, res) => {
    try {
      const { theme } = req.body;
      if (theme && (theme === 'light' || theme === 'dark')) {
        await db.query(
          `UPDATE settings SET value = $1 WHERE key = 'theme'`,
          [theme]
        );
      }
      const result = await db.query(`SELECT key, value FROM settings`);
      const settings = {};
      for (const row of result.rows) {
        settings[row.key] = row.value;
      }
      res.json(settings);
    } catch (err) {
      console.error('Error in PUT /api/settings:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
