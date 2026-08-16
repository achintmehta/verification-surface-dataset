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

// --- GET /api/summary ---
app.get('/api/summary', async (req, res) => {
  try {
    const db = await getDb();
    const totals = await db.query(
      `SELECT
         COALESCE(SUM(visitors),0)::bigint AS total_visitors,
         COALESCE(SUM(revenue),0)::numeric AS total_revenue
       FROM daily_metrics`
    );
    const best = await db.query(
      `SELECT date, revenue FROM daily_metrics ORDER BY revenue DESC, date DESC LIMIT 1`
    );
    // 7-day trend: sum of last 7 days vs the previous 7 days, by revenue.
    const ordered = await db.query(
      `SELECT date, revenue FROM daily_metrics ORDER BY date ASC`
    );
    const rows = ordered.rows;
    const last7 = rows.slice(-7).reduce((s, r) => s + Number(r.revenue), 0);
    const prev7 = rows.slice(-14, -7).reduce((s, r) => s + Number(r.revenue), 0);
    const trend = prev7 > 0 ? ((last7 - prev7) / prev7) * 100 : 0;

    res.json({
      totalVisitors: Number(totals.rows[0].total_visitors),
      totalRevenue: Number(totals.rows[0].total_revenue),
      bestDay: best.rows[0]
        ? { date: best.rows[0].date, revenue: Number(best.rows[0].revenue) }
        : null,
      trendPct: Math.round(trend * 10) / 10
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'summary_failed' });
  }
});

// --- GET /api/timeseries ---
app.get('/api/timeseries', async (req, res) => {
  try {
    const db = await getDb();
    const r = await db.query(
      `SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC`
    );
    res.json(
      r.rows.map((row) => ({
        date: row.date,
        visitors: Number(row.visitors),
        revenue: Number(row.revenue)
      }))
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'timeseries_failed' });
  }
});

// --- GET /api/categories ---
app.get('/api/categories', async (req, res) => {
  try {
    const db = await getDb();
    const r = await db.query(
      `SELECT name, value FROM categories ORDER BY value DESC`
    );
    res.json(r.rows.map((row) => ({ name: row.name, value: Number(row.value) })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'categories_failed' });
  }
});

// --- GET /api/recent ---
app.get('/api/recent', async (req, res) => {
  try {
    const db = await getDb();
    const r = await db.query(
      `SELECT name, category, value, created_at FROM recent_items
       ORDER BY created_at DESC LIMIT 20`
    );
    res.json(
      r.rows.map((row) => ({
        name: row.name,
        category: row.category,
        value: Number(row.value),
        createdAt: row.created_at
      }))
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'recent_failed' });
  }
});

// --- GET /api/settings ---
app.get('/api/settings', async (req, res) => {
  try {
    const db = await getDb();
    const r = await db.query(`SELECT theme FROM settings WHERE id = 1`);
    res.json({ theme: r.rows[0]?.theme || 'light' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'settings_failed' });
  }
});

// --- PUT /api/settings ---
app.put('/api/settings', async (req, res) => {
  try {
    const theme = req.body?.theme;
    if (theme !== 'light' && theme !== 'dark') {
      return res.status(400).json({ error: 'invalid_theme' });
    }
    const db = await getDb();
    await db.query(
      `INSERT INTO settings (id, theme) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET theme = EXCLUDED.theme`,
      [theme]
    );
    res.json({ theme });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'settings_update_failed' });
  }
});

// Serve built frontend in production (optional).
const distDir = path.join(__dirname, '..', 'dist');
app.use(express.static(distDir));

app.listen(PORT, () => {
  console.log(`Metrics dashboard server listening on http://localhost:${PORT}`);
});
