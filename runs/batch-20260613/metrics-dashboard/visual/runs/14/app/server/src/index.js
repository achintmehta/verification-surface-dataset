import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { getDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

// ---------- API ----------

app.get('/api/summary', async (req, res, next) => {
  try {
    const db = await getDb();
    const totals = await db.query(
      `SELECT
         COALESCE(SUM(visitors), 0)::bigint AS total_visitors,
         COALESCE(SUM(revenue), 0)::numeric AS total_revenue
       FROM daily_metrics`
    );

    const best = await db.query(
      `SELECT day, visitors FROM daily_metrics ORDER BY visitors DESC, day DESC LIMIT 1`
    );

    // 7-day trend: sum of last 7 days vs the previous 7 days.
    const series = await db.query(
      `SELECT day, visitors FROM daily_metrics ORDER BY day ASC`
    );
    const visitorsArr = series.rows.map((r) => Number(r.visitors));
    const n = visitorsArr.length;
    const last7 = visitorsArr.slice(Math.max(0, n - 7)).reduce((a, b) => a + b, 0);
    const prev7 = visitorsArr
      .slice(Math.max(0, n - 14), Math.max(0, n - 7))
      .reduce((a, b) => a + b, 0);
    let trendPct = 0;
    if (prev7 > 0) trendPct = ((last7 - prev7) / prev7) * 100;

    res.json({
      totalVisitors: Number(totals.rows[0].total_visitors),
      totalRevenue: Number(totals.rows[0].total_revenue),
      bestDay: best.rows[0]
        ? { day: best.rows[0].day, visitors: Number(best.rows[0].visitors) }
        : null,
      trendPct: Math.round(trendPct * 10) / 10,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/timeseries', async (req, res, next) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(
      `SELECT day, visitors, revenue FROM daily_metrics ORDER BY day ASC`
    );
    res.json(
      rows.map((r) => ({
        day: typeof r.day === 'string' ? r.day : new Date(r.day).toISOString().slice(0, 10),
        visitors: Number(r.visitors),
        revenue: Number(r.revenue),
      }))
    );
  } catch (err) {
    next(err);
  }
});

app.get('/api/categories', async (req, res, next) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(
      `SELECT id, name, value FROM categories ORDER BY value DESC`
    );
    res.json(rows.map((r) => ({ id: r.id, name: r.name, value: Number(r.value) })));
  } catch (err) {
    next(err);
  }
});

app.get('/api/recent', async (req, res, next) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(
      `SELECT id, name, category, value, created_at
       FROM recent_items ORDER BY created_at DESC LIMIT 20`
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        value: Number(r.value),
        createdAt:
          typeof r.created_at === 'string'
            ? r.created_at
            : new Date(r.created_at).toISOString(),
      }))
    );
  } catch (err) {
    next(err);
  }
});

app.get('/api/settings', async (req, res, next) => {
  try {
    const db = await getDb();
    const { rows } = await db.query('SELECT theme FROM settings WHERE id = 1');
    res.json({ theme: rows[0] ? rows[0].theme : 'light' });
  } catch (err) {
    next(err);
  }
});

app.put('/api/settings', async (req, res, next) => {
  try {
    const theme = req.body && req.body.theme;
    if (theme !== 'light' && theme !== 'dark') {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    const db = await getDb();
    await db.query(
      `INSERT INTO settings (id, theme) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET theme = EXCLUDED.theme`,
      [theme]
    );
    res.json({ theme });
  } catch (err) {
    next(err);
  }
});

// ---------- Static client (production build) ----------
const clientDist = path.resolve(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// ---------- Error handler ----------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

getDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`metrics-dashboard server listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
