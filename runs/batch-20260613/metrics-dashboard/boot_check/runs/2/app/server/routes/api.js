import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

// GET /api/summary
router.get('/summary', async (req, res) => {
  try {
    const db = await getDb();

    // Total visitors and revenue
    const { rows: totals } = await db.query(`
      SELECT
        SUM(visitors)::bigint AS total_visitors,
        SUM(revenue)::numeric AS total_revenue
      FROM daily_metrics
    `);

    // Best day (highest visitors)
    const { rows: bestDay } = await db.query(`
      SELECT date, visitors
      FROM daily_metrics
      ORDER BY visitors DESC
      LIMIT 1
    `);

    // 7-day trend: compare last 7 days vs previous 7 days (by visitors)
    const { rows: trend } = await db.query(`
      WITH ordered AS (
        SELECT visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM daily_metrics
      ),
      last7 AS (SELECT SUM(visitors) AS s FROM ordered WHERE rn <= 7),
      prev7 AS (SELECT SUM(visitors) AS s FROM ordered WHERE rn > 7 AND rn <= 14)
      SELECT
        last7.s AS last7,
        prev7.s AS prev7
      FROM last7, prev7
    `);

    const last7 = parseFloat(trend[0]?.last7 || 0);
    const prev7 = parseFloat(trend[0]?.prev7 || 0);
    const trendPct =
      prev7 > 0 ? (((last7 - prev7) / prev7) * 100).toFixed(1) : '0.0';

    const rawDate = bestDay[0]?.date;
    const bestDate = rawDate instanceof Date
      ? rawDate.toISOString().slice(0, 10)
      : String(rawDate).slice(0, 10);

    res.json({
      total_visitors: parseInt(totals[0].total_visitors, 10),
      total_revenue: parseFloat(totals[0].total_revenue).toFixed(2),
      best_day: {
        date: bestDate,
        visitors: parseInt(bestDay[0]?.visitors, 10),
      },
      trend_7day_pct: parseFloat(trendPct),
    });
  } catch (err) {
    console.error('[api/summary]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/timeseries
router.get('/timeseries', async (req, res) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(`
      SELECT date, visitors, revenue::numeric AS revenue
      FROM daily_metrics
      ORDER BY date ASC
    `);
    res.json(
      rows.map((r) => ({
        date: r.date instanceof Date
          ? r.date.toISOString().slice(0, 10)
          : String(r.date).slice(0, 10),
        visitors: parseInt(r.visitors, 10),
        revenue: parseFloat(r.revenue),
      }))
    );
  } catch (err) {
    console.error('[api/timeseries]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/categories
router.get('/categories', async (req, res) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(`
      SELECT name, value
      FROM categories
      ORDER BY value DESC
    `);
    res.json(
      rows.map((r) => ({
        name: r.name,
        value: parseInt(r.value, 10),
      }))
    );
  } catch (err) {
    console.error('[api/categories]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/recent
router.get('/recent', async (req, res) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(`
      SELECT id, name, category, value::numeric AS value, created_at
      FROM recent_items
      ORDER BY created_at DESC
      LIMIT 20
    `);
    res.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        value: parseFloat(r.value),
        created_at: r.created_at instanceof Date
          ? r.created_at.toISOString()
          : String(r.created_at),
      }))
    );
  } catch (err) {
    console.error('[api/recent]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/settings
router.get('/settings', async (req, res) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(
      "SELECT value FROM settings WHERE key = 'theme'"
    );
    const theme = rows[0]?.value || 'light';
    res.json({ theme });
  } catch (err) {
    console.error('[api/settings GET]', err);
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
    console.error('[api/settings PUT]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
