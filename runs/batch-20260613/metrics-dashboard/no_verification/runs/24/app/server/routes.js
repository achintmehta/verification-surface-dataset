const express = require('express');
const { getDB } = require('./db');

const router = express.Router();

// GET /api/summary
router.get('/summary', async (req, res) => {
  try {
    const db = getDB();

    // Total visitors
    const totalVisitors = await db.query('SELECT COALESCE(SUM(visitors), 0) AS total FROM daily_metrics');

    // Total revenue
    const totalRevenue = await db.query('SELECT COALESCE(SUM(revenue), 0) AS total FROM daily_metrics');

    // Best day (highest visitors)
    const bestDay = await db.query('SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1');

    // 7-day trend %: compare last 7 days avg to previous 7 days avg
    const trend = await db.query(`
      WITH ranked AS (
        SELECT visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM daily_metrics
      ),
      recent AS (
        SELECT AVG(visitors) AS avg_val FROM ranked WHERE rn <= 7
      ),
      previous AS (
        SELECT AVG(visitors) AS avg_val FROM ranked WHERE rn > 7 AND rn <= 14
      )
      SELECT
        CASE WHEN previous.avg_val = 0 THEN 0
             ELSE ROUND(((recent.avg_val - previous.avg_val) / previous.avg_val * 100)::numeric, 1)
        END AS trend_pct
      FROM recent, previous
    `);

    res.json({
      totalVisitors: parseInt(totalVisitors.rows[0].total, 10),
      totalRevenue: parseFloat(totalRevenue.rows[0].total),
      bestDay: {
        date: bestDay.rows[0].date,
        visitors: parseInt(bestDay.rows[0].visitors, 10),
      },
      trendPct: parseFloat(trend.rows[0].trend_pct),
    });
  } catch (err) {
    console.error('Error in /api/summary:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/timeseries
router.get('/timeseries', async (req, res) => {
  try {
    const db = getDB();
    const result = await db.query('SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC');
    res.json(
      result.rows.map((r) => ({
        date: r.date,
        visitors: parseInt(r.visitors, 10),
        revenue: parseFloat(r.revenue),
      }))
    );
  } catch (err) {
    console.error('Error in /api/timeseries:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/categories
router.get('/categories', async (req, res) => {
  try {
    const db = getDB();
    const result = await db.query('SELECT name, value FROM categories ORDER BY value DESC');
    res.json(
      result.rows.map((r) => ({
        name: r.name,
        value: parseInt(r.value, 10),
      }))
    );
  } catch (err) {
    console.error('Error in /api/categories:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/recent
router.get('/recent', async (req, res) => {
  try {
    const db = getDB();
    const result = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC');
    res.json(
      result.rows.map((r) => ({
        name: r.name,
        category: r.category,
        value: parseFloat(r.value),
        createdAt: r.created_at,
      }))
    );
  } catch (err) {
    console.error('Error in /api/recent:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/settings
router.get('/settings', async (req, res) => {
  try {
    const db = getDB();
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
    const db = getDB();
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
    console.error('Error in PUT /api/settings:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
