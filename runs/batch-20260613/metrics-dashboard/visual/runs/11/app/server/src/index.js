import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Helper to load db once per request (cached internally).
async function db() {
  return getDb();
}

app.get('/api/summary', async (req, res) => {
  try {
    const d = await db();
    const totals = await d.query(
      'SELECT COALESCE(SUM(visitors),0)::bigint AS total_visitors, COALESCE(SUM(revenue),0)::numeric AS total_revenue FROM daily_metrics;'
    );
    const best = await d.query(
      'SELECT day, visitors FROM daily_metrics ORDER BY visitors DESC, day ASC LIMIT 1;'
    );
    // 7-day trend: sum of last 7 days visitors vs the prior 7 days
    const series = await d.query(
      'SELECT day, visitors FROM daily_metrics ORDER BY day ASC;'
    );
    const rows = series.rows;
    const last7 = rows.slice(-7).reduce((a, r) => a + Number(r.visitors), 0);
    const prev7 = rows.slice(-14, -7).reduce((a, r) => a + Number(r.visitors), 0);
    const trendPct = prev7 === 0 ? 0 : ((last7 - prev7) / prev7) * 100;

    res.json({
      totalVisitors: Number(totals.rows[0].total_visitors),
      totalRevenue: Number(totals.rows[0].total_revenue),
      bestDay: best.rows[0]
        ? { day: best.rows[0].day, visitors: Number(best.rows[0].visitors) }
        : null,
      trendPct: +trendPct.toFixed(1),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'summary_failed' });
  }
});

app.get('/api/timeseries', async (req, res) => {
  try {
    const d = await db();
    const r = await d.query(
      'SELECT day, visitors, revenue FROM daily_metrics ORDER BY day ASC;'
    );
    res.json(
      r.rows.map((row) => ({
        day: row.day,
        visitors: Number(row.visitors),
        revenue: Number(row.revenue),
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'timeseries_failed' });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const d = await db();
    const r = await d.query(
      'SELECT name, value FROM categories ORDER BY value DESC;'
    );
    res.json(r.rows.map((row) => ({ name: row.name, value: Number(row.value) })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'categories_failed' });
  }
});

app.get('/api/recent', async (req, res) => {
  try {
    const d = await db();
    const r = await d.query(
      'SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC;'
    );
    res.json(
      r.rows.map((row) => ({
        name: row.name,
        category: row.category,
        value: Number(row.value),
        createdAt: row.created_at,
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'recent_failed' });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const d = await db();
    const r = await d.query('SELECT theme FROM settings WHERE id = 1;');
    const theme = r.rows[0] ? r.rows[0].theme : 'light';
    res.json({ theme });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'settings_failed' });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const { theme } = req.body || {};
    if (theme !== 'light' && theme !== 'dark') {
      return res.status(400).json({ error: 'invalid_theme' });
    }
    const d = await db();
    await d.query(
      "INSERT INTO settings (id, theme) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET theme = $1;",
      [theme]
    );
    res.json({ theme });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'settings_update_failed' });
  }
});

getDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Metrics dashboard API listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
