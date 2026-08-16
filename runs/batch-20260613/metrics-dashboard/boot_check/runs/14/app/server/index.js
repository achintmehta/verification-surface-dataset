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
      'SELECT COALESCE(SUM(visitors),0)::bigint AS total_visitors, COALESCE(SUM(revenue),0)::float8 AS total_revenue FROM daily_metrics'
    );
    const best = await db.query(
      'SELECT day, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1'
    );
    // 7-day trend: sum of visitors in the most recent 7 days vs the prior 7 days
    const ordered = await db.query('SELECT day, visitors FROM daily_metrics ORDER BY day ASC');
    const rows = ordered.rows;
    const n = rows.length;
    const last7 = rows.slice(Math.max(0, n - 7)).reduce((s, r) => s + Number(r.visitors), 0);
    const prev7 = rows.slice(Math.max(0, n - 14), Math.max(0, n - 7)).reduce((s, r) => s + Number(r.visitors), 0);
    const trendPct = prev7 === 0 ? 0 : ((last7 - prev7) / prev7) * 100;

    res.json({
      totalVisitors: Number(totals.rows[0].total_visitors),
      totalRevenue: Number(totals.rows[0].total_revenue),
      bestDay: best.rows[0]
        ? { day: best.rows[0].day, visitors: Number(best.rows[0].visitors) }
        : null,
      trendPct: Math.round(trendPct * 10) / 10
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'summary failed' });
  }
});

// --- GET /api/timeseries ---
app.get('/api/timeseries', async (req, res) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(
      'SELECT day, visitors, revenue::float8 AS revenue FROM daily_metrics ORDER BY day ASC'
    );
    res.json(
      rows.map((r) => ({
        day: typeof r.day === 'string' ? r.day : new Date(r.day).toISOString().slice(0, 10),
        visitors: Number(r.visitors),
        revenue: Number(r.revenue)
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'timeseries failed' });
  }
});

// --- GET /api/categories ---
app.get('/api/categories', async (req, res) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(
      'SELECT id, name, value::float8 AS value FROM categories ORDER BY value DESC'
    );
    res.json(rows.map((r) => ({ id: r.id, name: r.name, value: Number(r.value) })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'categories failed' });
  }
});

// --- GET /api/recent ---
app.get('/api/recent', async (req, res) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(
      'SELECT id, name, category, value::float8 AS value, created_at FROM recent_items ORDER BY created_at DESC'
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        value: Number(r.value),
        createdAt: typeof r.created_at === 'string' ? r.created_at : new Date(r.created_at).toISOString()
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'recent failed' });
  }
});

// --- GET /api/settings ---
app.get('/api/settings', async (req, res) => {
  try {
    const db = await getDb();
    const { rows } = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    const theme = rows[0] ? rows[0].value : 'light';
    res.json({ theme });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'settings failed' });
  }
});

// --- PUT /api/settings ---
app.put('/api/settings', async (req, res) => {
  try {
    const theme = req.body && req.body.theme;
    if (theme !== 'light' && theme !== 'dark') {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    const db = await getDb();
    await db.query(
      "INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [theme]
    );
    res.json({ theme });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'settings update failed' });
  }
});

// Serve built frontend in production if present.
const distDir = path.join(__dirname, '..', 'dist');
app.use(express.static(distDir));

app.listen(PORT, () => {
  console.log(`Metrics dashboard API listening on http://localhost:${PORT}`);
});
