import { Router } from 'express';
import { getDb } from './db.js';

const router = Router();

// GET /api/summary
router.get('/summary', async (req, res) => {
  try {
    const db = getDb();

    const totalVisitors = await db.query(
      'SELECT SUM(visitors) AS total FROM daily_metrics'
    );
    const totalRevenue = await db.query(
      'SELECT SUM(revenue) AS total FROM daily_metrics'
    );
    const bestDay = await db.query(
      'SELECT date, revenue FROM daily_metrics ORDER BY revenue DESC LIMIT 1'
    );

    // 7-day trend: compare last 7 days vs previous 7 days by visitors
    const trend = await db.query(`
      WITH ordered AS (
        SELECT visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM daily_metrics
      ),
      last7   AS (SELECT AVG(visitors) AS avg FROM ordered WHERE rn <= 7),
      prev7   AS (SELECT AVG(visitors) AS avg FROM ordered WHERE rn > 7 AND rn <= 14)
      SELECT
        last7.avg AS last_avg,
        prev7.avg AS prev_avg
      FROM last7, prev7
    `);

    const lastAvg = parseFloat(trend.rows[0].last_avg) || 0;
    const prevAvg = parseFloat(trend.rows[0].prev_avg) || 0;
    const trendPct = prevAvg === 0 ? 0 : ((lastAvg - prevAvg) / prevAvg) * 100;

    res.json({
      totalVisitors: parseInt(totalVisitors.rows[0].total, 10),
      totalRevenue: parseFloat(totalRevenue.rows[0].total),
      bestDayDate: bestDay.rows[0].date,
      bestDayRevenue: parseFloat(bestDay.rows[0].revenue),
      trendPct: Math.round(trendPct * 10) / 10,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/timeseries
router.get('/timeseries', async (req, res) => {
  try {
    const db = getDb();
    const { rows } = await db.query(
      'SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC'
    );
    res.json(rows.map(r => ({
      date: r.date,
      visitors: parseInt(r.visitors, 10),
      revenue: parseFloat(r.revenue),
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/categories
router.get('/categories', async (req, res) => {
  try {
    const db = getDb();
    const { rows } = await db.query(
      'SELECT name, value FROM categories ORDER BY value DESC'
    );
    res.json(rows.map(r => ({
      name: r.name,
      value: parseFloat(r.value),
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/recent
router.get('/recent', async (req, res) => {
  try {
    const db = getDb();
    const { rows } = await db.query(
      'SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20'
    );
    res.json(rows.map(r => ({
      name: r.name,
      category: r.category,
      value: parseFloat(r.value),
      createdAt: r.created_at,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings
router.get('/settings', async (req, res) => {
  try {
    const db = getDb();
    const { rows } = await db.query(
      "SELECT value FROM settings WHERE key = 'theme'"
    );
    const theme = rows.length > 0 ? rows[0].value : 'light';
    res.json({ theme });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings
router.put('/settings', async (req, res) => {
  try {
    const db = getDb();
    const { theme } = req.body;
    if (!['light', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    await db.query(
      "INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [theme]
    );
    res.json({ theme });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
