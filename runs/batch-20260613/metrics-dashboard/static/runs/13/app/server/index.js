import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Helper to wrap async route handlers and forward errors.
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error', message: String(err && err.message || err) });
});

// GET /api/summary — four headline numbers.
app.get('/api/summary', wrap(async (req, res) => {
  const db = await getDb();
  const totals = await db.query(
    `SELECT
       COALESCE(SUM(visitors), 0)::bigint AS total_visitors,
       COALESCE(SUM(revenue), 0)::bigint  AS total_revenue
     FROM daily_metrics`
  );
  const best = await db.query(
    `SELECT day, visitors FROM daily_metrics ORDER BY visitors DESC, day ASC LIMIT 1`
  );
  // 7-day trend %: sum of last 7 days vs the prior 7 days, by visitors.
  const trendRows = await db.query(
    `WITH ordered AS (
       SELECT day, visitors,
              ROW_NUMBER() OVER (ORDER BY day DESC) AS rn
       FROM daily_metrics
     )
     SELECT
       COALESCE(SUM(visitors) FILTER (WHERE rn <= 7), 0)::bigint  AS last7,
       COALESCE(SUM(visitors) FILTER (WHERE rn > 7 AND rn <= 14), 0)::bigint AS prev7
     FROM ordered`
  );
  const last7 = Number(trendRows.rows[0].last7);
  const prev7 = Number(trendRows.rows[0].prev7);
  const trendPct = prev7 === 0 ? 0 : ((last7 - prev7) / prev7) * 100;

  res.json({
    totalVisitors: Number(totals.rows[0].total_visitors),
    totalRevenue: Number(totals.rows[0].total_revenue),
    bestDay: best.rows[0]
      ? { day: best.rows[0].day, visitors: best.rows[0].visitors }
      : null,
    trendPct: Math.round(trendPct * 10) / 10,
  });
}));

// GET /api/timeseries — 30-day series.
app.get('/api/timeseries', wrap(async (req, res) => {
  const db = await getDb();
  const { rows } = await db.query(
    `SELECT day, visitors, revenue FROM daily_metrics ORDER BY day ASC`
  );
  res.json(rows.map((r) => ({
    day: typeof r.day === 'string' ? r.day : new Date(r.day).toISOString().slice(0, 10),
    visitors: Number(r.visitors),
    revenue: Number(r.revenue),
  })));
}));

// GET /api/categories — breakdown bars.
app.get('/api/categories', wrap(async (req, res) => {
  const db = await getDb();
  const { rows } = await db.query(
    `SELECT name, value FROM categories ORDER BY value DESC`
  );
  res.json(rows.map((r) => ({ name: r.name, value: Number(r.value) })));
}));

// GET /api/recent — recent items table.
app.get('/api/recent', wrap(async (req, res) => {
  const db = await getDb();
  const { rows } = await db.query(
    `SELECT name, category, value, created_at
     FROM recent_items ORDER BY created_at DESC LIMIT 20`
  );
  res.json(rows.map((r) => ({
    name: r.name,
    category: r.category,
    value: Number(r.value),
    createdAt: new Date(r.created_at).toISOString(),
  })));
}));

// GET /api/settings — theme preference.
app.get('/api/settings', wrap(async (req, res) => {
  const db = await getDb();
  const { rows } = await db.query('SELECT theme FROM settings WHERE id = 1');
  res.json({ theme: rows[0] ? rows[0].theme : 'light' });
}));

// PUT /api/settings — persist theme.
app.put('/api/settings', wrap(async (req, res) => {
  const theme = req.body && req.body.theme;
  if (theme !== 'light' && theme !== 'dark') {
    res.status(400).json({ error: 'invalid_theme', message: 'theme must be "light" or "dark"' });
    return;
  }
  const db = await getDb();
  await db.query(
    `INSERT INTO settings (id, theme) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET theme = EXCLUDED.theme`,
    [theme]
  );
  res.json({ theme });
}));

// Serve the built frontend in production (after `vite build`).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');
app.use(express.static(distDir));

getDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`API + static server listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
