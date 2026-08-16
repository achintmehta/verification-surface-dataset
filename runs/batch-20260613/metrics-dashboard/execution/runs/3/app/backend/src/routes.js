import { Router } from 'express';
import { getDb } from './db.js';

const router = Router();

// ── GET /api/summary ─────────────────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const db = getDb();

    // Total visitors
    const { rows: visRows } = await db.query(
      'SELECT SUM(visitors) AS total_visitors FROM daily_metrics'
    );
    const totalVisitors = parseInt(visRows[0].total_visitors, 10);

    // Total revenue
    const { rows: revRows } = await db.query(
      'SELECT SUM(revenue) AS total_revenue FROM daily_metrics'
    );
    const totalRevenue = parseFloat(revRows[0].total_revenue);

    // Best day (highest visitors)
    const { rows: bestRows } = await db.query(
      'SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1'
    );
    const bestDay = {
      date: bestRows[0].date,
      visitors: parseInt(bestRows[0].visitors, 10),
    };

    // 7-day trend: compare last 7 days vs previous 7 days (by visitors)
    const { rows: trendRows } = await db.query(`
      SELECT
        SUM(CASE WHEN rn <= 7  THEN visitors ELSE 0 END) AS last7,
        SUM(CASE WHEN rn > 7 AND rn <= 14 THEN visitors ELSE 0 END) AS prev7
      FROM (
        SELECT visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM daily_metrics
      ) sub
      WHERE rn <= 14
    `);
    const last7 = parseInt(trendRows[0].last7, 10) || 0;
    const prev7 = parseInt(trendRows[0].prev7, 10) || 0;
    const trendPct = prev7 === 0 ? 0 : Math.round(((last7 - prev7) / prev7) * 1000) / 10;

    res.json({ totalVisitors, totalRevenue, bestDay, trendPct });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

// ── GET /api/timeseries ───────────────────────────────────────────────────────
router.get('/timeseries', async (req, res) => {
  try {
    const db = getDb();
    const { rows } = await db.query(
      'SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC'
    );
    const data = rows.map((r) => ({
      date: r.date,
      visitors: parseInt(r.visitors, 10),
      revenue: parseFloat(r.revenue),
    }));
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch timeseries' });
  }
});

// ── GET /api/categories ───────────────────────────────────────────────────────
router.get('/categories', async (req, res) => {
  try {
    const db = getDb();
    const { rows } = await db.query(
      'SELECT name, value FROM categories ORDER BY value DESC'
    );
    const data = rows.map((r) => ({
      name: r.name,
      value: parseInt(r.value, 10),
    }));
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// ── GET /api/recent ───────────────────────────────────────────────────────────
router.get('/recent', async (req, res) => {
  try {
    const db = getDb();
    const { rows } = await db.query(
      'SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20'
    );
    const data = rows.map((r) => ({
      name: r.name,
      category: r.category,
      value: parseFloat(r.value),
      created_at: r.created_at,
    }));
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch recent items' });
  }
});

// ── GET /api/settings ─────────────────────────────────────────────────────────
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
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// ── PUT /api/settings ─────────────────────────────────────────────────────────
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
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

export default router;
