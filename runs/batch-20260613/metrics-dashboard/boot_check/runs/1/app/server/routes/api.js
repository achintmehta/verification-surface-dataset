import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

// GET /api/summary
router.get('/summary', async (req, res) => {
  try {
    const db = await getDb();

    // Total visitors and revenue
    const totals = await db.query(`
      SELECT
        SUM(visitors)::bigint AS total_visitors,
        SUM(revenue)::numeric AS total_revenue
      FROM daily_metrics
    `);

    // Best day by revenue
    const bestDay = await db.query(`
      SELECT date, revenue
      FROM daily_metrics
      ORDER BY revenue DESC
      LIMIT 1
    `);

    // 7-day trend: compare last 7 days vs previous 7 days (by visitors)
    const trend = await db.query(`
      WITH ordered AS (
        SELECT visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM daily_metrics
      ),
      last7   AS (SELECT SUM(visitors)::numeric AS s FROM ordered WHERE rn <= 7),
      prev7   AS (SELECT SUM(visitors)::numeric AS s FROM ordered WHERE rn > 7 AND rn <= 14)
      SELECT
        last7.s AS last7,
        prev7.s AS prev7,
        CASE
          WHEN prev7.s = 0 OR prev7.s IS NULL THEN 0
          ELSE ROUND(((last7.s - prev7.s) / prev7.s) * 100, 1)
        END AS trend_pct
      FROM last7, prev7
    `);

    const row = totals.rows[0];
    const best = bestDay.rows[0];
    const trendRow = trend.rows[0];

    res.json({
      total_visitors: parseInt(row.total_visitors, 10),
      total_revenue: parseFloat(row.total_revenue),
      best_day_date: best.date,
      best_day_revenue: parseFloat(best.revenue),
      trend_pct: parseFloat(trendRow.trend_pct),
    });
  } catch (err) {
    console.error('GET /api/summary error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/timeseries
router.get('/timeseries', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(`
      SELECT date, visitors, revenue::numeric AS revenue
      FROM daily_metrics
      ORDER BY date ASC
    `);
    res.json(result.rows.map(r => ({
      date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
      visitors: parseInt(r.visitors, 10),
      revenue: parseFloat(r.revenue),
    })));
  } catch (err) {
    console.error('GET /api/timeseries error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/categories
router.get('/categories', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(`
      SELECT name, value
      FROM categories
      ORDER BY value DESC
    `);
    res.json(result.rows.map(r => ({
      name: r.name,
      value: parseInt(r.value, 10),
    })));
  } catch (err) {
    console.error('GET /api/categories error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/recent
router.get('/recent', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(`
      SELECT id, name, category, value::numeric AS value, created_at
      FROM recent_items
      ORDER BY created_at DESC
      LIMIT 20
    `);
    res.json(result.rows.map(r => ({
      id: r.id,
      name: r.name,
      category: r.category,
      value: parseFloat(r.value),
      created_at: r.created_at instanceof Date
        ? r.created_at.toISOString()
        : String(r.created_at),
    })));
  } catch (err) {
    console.error('GET /api/recent error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/settings
router.get('/settings', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(`SELECT value FROM settings WHERE key = 'theme'`);
    const theme = result.rows.length > 0 ? result.rows[0].value : 'light';
    res.json({ theme });
  } catch (err) {
    console.error('GET /api/settings error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/settings
router.put('/settings', async (req, res) => {
  try {
    const { theme } = req.body;
    if (theme !== 'light' && theme !== 'dark') {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    const db = await getDb();
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('theme', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [theme]
    );
    res.json({ theme });
  } catch (err) {
    console.error('PUT /api/settings error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
