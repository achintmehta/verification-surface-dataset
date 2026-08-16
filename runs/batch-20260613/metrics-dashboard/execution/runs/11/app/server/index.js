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

// Helper to wrap async route handlers and forward errors.
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: String(err.message || err) });
  });

// GET /api/summary -> four headline numbers
app.get(
  '/api/summary',
  wrap(async (req, res) => {
    const db = await getDb();
    const rows = (
      await db.query(
        'SELECT date, visitors, revenue::float8 AS revenue FROM daily_metrics ORDER BY date ASC'
      )
    ).rows;

    const totalVisitors = rows.reduce((a, r) => a + Number(r.visitors), 0);
    const totalRevenue = rows.reduce((a, r) => a + Number(r.revenue), 0);

    // best day = day with highest revenue
    let best = rows[0];
    for (const r of rows) if (Number(r.revenue) > Number(best.revenue)) best = r;

    // 7-day trend: last 7 days revenue vs the previous 7 days
    const last7 = rows.slice(-7).reduce((a, r) => a + Number(r.revenue), 0);
    const prev7 = rows.slice(-14, -7).reduce((a, r) => a + Number(r.revenue), 0);
    const trendPct = prev7 === 0 ? 0 : ((last7 - prev7) / prev7) * 100;

    res.json({
      totalVisitors,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      bestDay: best ? { date: best.date, revenue: Number(best.revenue) } : null,
      trendPct: Math.round(trendPct * 10) / 10
    });
  })
);

// GET /api/timeseries -> 30-day series
app.get(
  '/api/timeseries',
  wrap(async (req, res) => {
    const db = await getDb();
    const rows = (
      await db.query(
        'SELECT date, visitors, revenue::float8 AS revenue FROM daily_metrics ORDER BY date ASC'
      )
    ).rows;
    res.json(
      rows.map((r) => ({
        date: r.date,
        visitors: Number(r.visitors),
        revenue: Number(r.revenue)
      }))
    );
  })
);

// GET /api/categories
app.get(
  '/api/categories',
  wrap(async (req, res) => {
    const db = await getDb();
    const rows = (
      await db.query('SELECT name, value::float8 AS value FROM categories ORDER BY value DESC')
    ).rows;
    res.json(rows.map((r) => ({ name: r.name, value: Number(r.value) })));
  })
);

// GET /api/recent
app.get(
  '/api/recent',
  wrap(async (req, res) => {
    const db = await getDb();
    const rows = (
      await db.query(
        'SELECT name, category, value::float8 AS value, created_at FROM recent_items ORDER BY created_at DESC'
      )
    ).rows;
    res.json(
      rows.map((r) => ({
        name: r.name,
        category: r.category,
        value: Number(r.value),
        createdAt: r.created_at
      }))
    );
  })
);

// GET /api/settings
app.get(
  '/api/settings',
  wrap(async (req, res) => {
    const db = await getDb();
    const row = (await db.query('SELECT theme FROM settings WHERE id = 1')).rows[0];
    res.json({ theme: row ? row.theme : 'light' });
  })
);

// PUT /api/settings -> persist theme
app.put(
  '/api/settings',
  wrap(async (req, res) => {
    const { theme } = req.body || {};
    if (theme !== 'light' && theme !== 'dark') {
      return res.status(400).json({ error: 'invalid_theme', message: "theme must be 'light' or 'dark'" });
    }
    const db = await getDb();
    await db.query(
      `INSERT INTO settings (id, theme) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET theme = EXCLUDED.theme`,
      [theme]
    );
    res.json({ theme });
  })
);

// In production, serve the built frontend from /dist.
const distDir = path.join(__dirname, '..', 'dist');
app.use(express.static(distDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distDir, 'index.html'), (err) => {
    if (err) next();
  });
});

getDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`API server listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
