import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Helpers ---------------------------------------------------------------

function num(v) {
  return v === null || v === undefined ? 0 : Number(v);
}

// Routes ----------------------------------------------------------------

app.get('/api/summary', async (req, res) => {
  try {
    const db = await getDb();
    const totals = await db.query(
      'SELECT SUM(visitors)::bigint AS total_visitors, SUM(revenue)::numeric AS total_revenue FROM daily_metrics'
    );
    const best = await db.query(
      'SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC, date DESC LIMIT 1'
    );
    // 7-day trend: compare sum of last 7 days revenue vs the previous 7 days.
    const series = await db.query(
      'SELECT date, revenue FROM daily_metrics ORDER BY date ASC'
    );
    const rows = series.rows;
    const last7 = rows.slice(-7).reduce((a, r) => a + num(r.revenue), 0);
    const prev7 = rows.slice(-14, -7).reduce((a, r) => a + num(r.revenue), 0);
    let trend = 0;
    if (prev7 > 0) trend = ((last7 - prev7) / prev7) * 100;

    const bestRow = best.rows[0] || {};
    res.json({
      totalVisitors: num(totals.rows[0].total_visitors),
      totalRevenue: num(totals.rows[0].total_revenue),
      bestDay: {
        date: bestRow.date ? new Date(bestRow.date).toISOString().slice(0, 10) : null,
        visitors: num(bestRow.visitors),
      },
      trend7d: Math.round(trend * 10) / 10,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'summary_failed' });
  }
});

app.get('/api/timeseries', async (req, res) => {
  try {
    const db = await getDb();
    const r = await db.query('SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC');
    res.json(
      r.rows.map((row) => ({
        date: new Date(row.date).toISOString().slice(0, 10),
        visitors: num(row.visitors),
        revenue: num(row.revenue),
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'timeseries_failed' });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const db = await getDb();
    const r = await db.query('SELECT name, value FROM categories ORDER BY value DESC');
    res.json(r.rows.map((row) => ({ name: row.name, value: num(row.value) })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'categories_failed' });
  }
});

app.get('/api/recent', async (req, res) => {
  try {
    const db = await getDb();
    const r = await db.query(
      'SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20'
    );
    res.json(
      r.rows.map((row) => ({
        name: row.name,
        category: row.category,
        value: num(row.value),
        createdAt: new Date(row.created_at).toISOString(),
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'recent_failed' });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const db = await getDb();
    const r = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    const theme = r.rows[0] ? r.rows[0].value : 'light';
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
    const db = await getDb();
    await db.query(
      "INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [theme]
    );
    res.json({ theme });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'settings_update_failed' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

getDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Metrics dashboard API listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
