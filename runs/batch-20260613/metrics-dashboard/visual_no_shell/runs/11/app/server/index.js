import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/summary', async (req, res) => {
  try {
    const db = await getDb();
    const totals = await db.query(
      'SELECT COALESCE(SUM(visitors),0)::bigint AS total_visitors, COALESCE(SUM(revenue),0) AS total_revenue FROM daily_metrics'
    );
    const best = await db.query(
      'SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC, date DESC LIMIT 1'
    );
    // 7-day trend: sum visitors of last 7 days vs previous 7 days
    const rows = (await db.query('SELECT visitors FROM daily_metrics ORDER BY date ASC')).rows;
    const n = rows.length;
    const last7 = rows.slice(Math.max(0, n - 7)).reduce((a, r) => a + Number(r.visitors), 0);
    const prev7 = rows.slice(Math.max(0, n - 14), Math.max(0, n - 7)).reduce((a, r) => a + Number(r.visitors), 0);
    const trend = prev7 > 0 ? ((last7 - prev7) / prev7) * 100 : 0;

    res.json({
      totalVisitors: Number(totals.rows[0].total_visitors),
      totalRevenue: Number(totals.rows[0].total_revenue),
      bestDay: best.rows[0]
        ? { date: best.rows[0].date, visitors: Number(best.rows[0].visitors) }
        : null,
      trend7d: Math.round(trend * 10) / 10
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'summary_failed' });
  }
});

app.get('/api/timeseries', async (req, res) => {
  try {
    const db = await getDb();
    const r = await db.query(
      'SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC'
    );
    res.json(
      r.rows.map((row) => ({
        date: typeof row.date === 'string' ? row.date.slice(0, 10) : new Date(row.date).toISOString().slice(0, 10),
        visitors: Number(row.visitors),
        revenue: Number(row.revenue)
      }))
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'timeseries_failed' });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const db = await getDb();
    const r = await db.query('SELECT name, value FROM categories ORDER BY value DESC');
    res.json(r.rows.map((row) => ({ name: row.name, value: Number(row.value) })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'categories_failed' });
  }
});

app.get('/api/recent', async (req, res) => {
  try {
    const db = await getDb();
    const r = await db.query(
      'SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC'
    );
    res.json(
      r.rows.map((row) => ({
        name: row.name,
        category: row.category,
        value: Number(row.value),
        createdAt: new Date(row.created_at).toISOString()
      }))
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'recent_failed' });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const db = await getDb();
    const r = await db.query('SELECT theme FROM settings WHERE id = 1');
    res.json({ theme: r.rows[0] ? r.rows[0].theme : 'light' });
  } catch (e) {
    console.error(e);
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
      "INSERT INTO settings (id, theme) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET theme = EXCLUDED.theme",
      [theme]
    );
    res.json({ theme });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'settings_update_failed' });
  }
});

// Serve built client in production if present.
const distDir = path.join(__dirname, '..', 'dist');
app.use(express.static(distDir));

app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});
