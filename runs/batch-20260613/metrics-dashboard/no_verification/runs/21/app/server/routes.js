import { Router } from 'express';
import { getDb } from './db.js';

const router = Router();

// GET /api/summary
// Returns: totalVisitors, totalRevenue, bestDay, sevenDayTrend
router.get('/api/summary', async (_req, res) => {
  try {
    const db = await getDb();

    const totals = await db.query(`
      SELECT 
        SUM(visitors)::integer AS total_visitors,
        SUM(revenue)::numeric AS total_revenue
      FROM daily_metrics
    `);

    const bestDay = await db.query(`
      SELECT date, visitors FROM daily_metrics
      ORDER BY visitors DESC LIMIT 1
    `);

    // 7-day trend: compare last 7 days avg to previous 7 days avg
    const trend = await db.query(`
      WITH ordered AS (
        SELECT visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM daily_metrics
      )
      SELECT
        AVG(CASE WHEN rn <= 7 THEN visitors END) AS recent_avg,
        AVG(CASE WHEN rn > 7 AND rn <= 14 THEN visitors END) AS prev_avg
      FROM ordered
    `);

    const recentAvg = parseFloat(trend.rows[0].recent_avg) || 0;
    const prevAvg = parseFloat(trend.rows[0].prev_avg) || 1;
    const trendPct = ((recentAvg - prevAvg) / prevAvg * 100).toFixed(1);

    res.json({
      totalVisitors: parseInt(totals.rows[0].total_visitors, 10),
      totalRevenue: parseFloat(totals.rows[0].total_revenue),
      bestDay: {
        date: bestDay.rows[0].date,
        visitors: bestDay.rows[0].visitors,
      },
      sevenDayTrend: parseFloat(trendPct),
    });
  } catch (err) {
    console.error('Error in /api/summary:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/timeseries
router.get('/api/timeseries', async (_req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(
      'SELECT date, visitors, revenue::numeric FROM daily_metrics ORDER BY date ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error in /api/timeseries:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/categories
router.get('/api/categories', async (_req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(
      'SELECT id, name, value FROM categories ORDER BY value DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error in /api/categories:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/recent
router.get('/api/recent', async (_req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(
      'SELECT id, name, category, value::numeric, created_at FROM recent_items ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error in /api/recent:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/settings
router.get('/api/settings', async (_req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(
      "SELECT value FROM settings WHERE key = 'theme'"
    );
    const theme = result.rows.length > 0 ? result.rows[0].value : 'light';
    res.json({ theme });
  } catch (err) {
    console.error('Error in GET /api/settings:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/settings
router.put('/api/settings', async (req, res) => {
  try {
    const { theme } = req.body;
    if (!theme || !['light', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    const db = await getDb();
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

export default router;
