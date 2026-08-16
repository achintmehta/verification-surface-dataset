const express = require('express');
const cors = require('cors');
const path = require('path');
const { getDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve static frontend build if it exists
const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(frontendDist));

// ─── API Routes ──────────────────────────────────────────────

/**
 * GET /api/summary
 * Returns: { totalVisitors, totalRevenue, bestDay, sevenDayTrend }
 */
app.get('/api/summary', async (req, res) => {
  try {
    const db = await getDb();

    const totals = await db.query(`
      SELECT
        SUM(visitors)::int AS total_visitors,
        SUM(revenue)::numeric AS total_revenue
      FROM daily_metrics
    `);

    const bestDay = await db.query(`
      SELECT date, visitors
      FROM daily_metrics
      ORDER BY visitors DESC
      LIMIT 1
    `);

    // 7-day trend: compare last 7 days avg to previous 7 days avg
    const trend = await db.query(`
      WITH ordered AS (
        SELECT visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM daily_metrics
      )
      SELECT
        COALESCE(AVG(CASE WHEN rn <= 7 THEN visitors END), 0) AS recent_avg,
        COALESCE(AVG(CASE WHEN rn > 7 AND rn <= 14 THEN visitors END), 0) AS prev_avg
      FROM ordered
    `);

    const recentAvg = parseFloat(trend.rows[0].recent_avg);
    const prevAvg = parseFloat(trend.rows[0].prev_avg);
    const trendPct = prevAvg > 0
      ? Math.round(((recentAvg - prevAvg) / prevAvg) * 10000) / 100
      : 0;

    res.json({
      totalVisitors: totals.rows[0].total_visitors,
      totalRevenue: parseFloat(totals.rows[0].total_revenue),
      bestDay: {
        date: bestDay.rows[0].date,
        visitors: bestDay.rows[0].visitors,
      },
      sevenDayTrend: trendPct,
    });
  } catch (err) {
    console.error('Error in /api/summary:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/timeseries
 * Returns array of { date, visitors, revenue }
 */
app.get('/api/timeseries', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(
      'SELECT date, visitors, revenue::numeric FROM daily_metrics ORDER BY date ASC'
    );
    res.json(
      result.rows.map((r) => ({
        date: r.date,
        visitors: r.visitors,
        revenue: parseFloat(r.revenue),
      }))
    );
  } catch (err) {
    console.error('Error in /api/timeseries:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/categories
 * Returns array of { name, value }
 */
app.get('/api/categories', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(
      'SELECT name, value FROM categories ORDER BY value DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error in /api/categories:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/recent
 * Returns array of { name, category, value, created_at }
 */
app.get('/api/recent', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(
      'SELECT name, category, value::numeric, created_at FROM recent_items ORDER BY created_at DESC'
    );
    res.json(
      result.rows.map((r) => ({
        ...r,
        value: parseFloat(r.value),
      }))
    );
  } catch (err) {
    console.error('Error in /api/recent:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/settings
 * Returns { theme: "light" | "dark" }
 */
app.get('/api/settings', async (req, res) => {
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

/**
 * PUT /api/settings
 * Body: { theme: "light" | "dark" }
 */
app.put('/api/settings', async (req, res) => {
  try {
    const { theme } = req.body;
    if (theme !== 'light' && theme !== 'dark') {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    const db = await getDb();
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

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
