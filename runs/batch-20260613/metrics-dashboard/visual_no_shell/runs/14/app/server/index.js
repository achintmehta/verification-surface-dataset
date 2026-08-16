import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Ensure DB is ready before serving requests.
let dbReady = getDb();

app.use(async (req, res, next) => {
  try {
    req.db = await dbReady;
    next();
  } catch (err) {
    console.error('DB init failed', err);
    res.status(500).json({ error: 'Database unavailable' });
  }
});

// GET /api/summary -> four headline numbers
app.get('/api/summary', async (req, res) => {
  try {
    const db = req.db;
    const totals = await db.query(
      'SELECT COALESCE(SUM(visitors),0)::bigint AS total_visitors, COALESCE(SUM(revenue),0)::numeric AS total_revenue FROM daily_metrics'
    );
    const best = await db.query(
      'SELECT day, visitors FROM daily_metrics ORDER BY visitors DESC, day ASC LIMIT 1'
    );

    // 7-day trend: last 7 days visitors vs previous 7 days
    const ordered = await db.query(
      'SELECT visitors FROM daily_metrics ORDER BY day ASC'
    );
    const v = ordered.rows.map((r) => Number(r.visitors));
    const last7 = v.slice(-7).reduce((a, b) => a + b, 0);
    const prev7 = v.slice(-14, -7).reduce((a, b) => a + b, 0);
    let trendPct = 0;
    if (prev7 > 0) trendPct = ((last7 - prev7) / prev7) * 100;

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
    res.status(500).json({ error: 'Failed to compute summary' });
  }
});

// GET /api/timeseries
app.get('/api/timeseries', async (req, res) => {
  try {
    const { rows } = await req.db.query(
      'SELECT day, visitors, revenue FROM daily_metrics ORDER BY day ASC'
    );
    res.json(
      rows.map((r) => ({
        day: typeof r.day === 'string' ? r.day : new Date(r.day).toISOString().slice(0, 10),
        visitors: Number(r.visitors),
        revenue: Number(r.revenue),
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load timeseries' });
  }
});

// GET /api/categories
app.get('/api/categories', async (req, res) => {
  try {
    const { rows } = await req.db.query(
      'SELECT id, name, value FROM categories ORDER BY value DESC'
    );
    res.json(rows.map((r) => ({ id: r.id, name: r.name, value: Number(r.value) })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load categories' });
  }
});

// GET /api/recent
app.get('/api/recent', async (req, res) => {
  try {
    const { rows } = await req.db.query(
      'SELECT id, name, category, value, created_at FROM recent_items ORDER BY created_at DESC'
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        value: Number(r.value),
        createdAt: new Date(r.created_at).toISOString(),
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load recent items' });
  }
});

// GET /api/settings
app.get('/api/settings', async (req, res) => {
  try {
    const { rows } = await req.db.query("SELECT value FROM settings WHERE key = 'theme'");
    res.json({ theme: rows[0] ? rows[0].value : 'light' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// PUT /api/settings
app.put('/api/settings', async (req, res) => {
  try {
    const theme = req.body && req.body.theme;
    if (theme !== 'light' && theme !== 'dark') {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    await req.db.query(
      "INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [theme]
    );
    res.json({ theme });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

app.listen(PORT, () => {
  console.log(`Metrics dashboard API listening on http://localhost:${PORT}`);
});
