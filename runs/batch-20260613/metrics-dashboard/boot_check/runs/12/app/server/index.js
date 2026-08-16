import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { getDb } from './src/db.js';

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
      'SELECT COALESCE(SUM(visitors),0)::int AS total_visitors, COALESCE(SUM(revenue),0)::bigint AS total_revenue FROM daily_metrics'
    );
    const best = await db.query(
      'SELECT date, revenue FROM daily_metrics ORDER BY revenue DESC, date DESC LIMIT 1'
    );
    // 7-day trend: sum of last 7 days vs the previous 7 days (by date).
    const ordered = await db.query('SELECT visitors FROM daily_metrics ORDER BY date ASC');
    const visitors = ordered.rows.map((r) => r.visitors);
    const last7 = visitors.slice(-7).reduce((a, b) => a + b, 0);
    const prev7 = visitors.slice(-14, -7).reduce((a, b) => a + b, 0);
    let trendPct = 0;
    if (prev7 > 0) trendPct = ((last7 - prev7) / prev7) * 100;
    else if (last7 > 0) trendPct = 100;

    const bestRow = best.rows[0] || { date: null, revenue: 0 };
    res.json({
      totalVisitors: Number(totals.rows[0].total_visitors),
      totalRevenue: Number(totals.rows[0].total_revenue),
      bestDay: {
        date: bestRow.date ? new Date(bestRow.date).toISOString().slice(0, 10) : null,
        revenue: Number(bestRow.revenue),
      },
      trendPct: Math.round(trendPct * 10) / 10,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/timeseries', async (req, res, next) => {
  try {
    const db = await getDb();
    const r = await db.query('SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC');
    res.json(
      r.rows.map((row) => ({
        date: new Date(row.date).toISOString().slice(0, 10),
        visitors: row.visitors,
        revenue: Number(row.revenue),
      }))
    );
  } catch (err) {
    next(err);
  }
});

app.get('/api/categories', async (req, res, next) => {
  try {
    const db = await getDb();
    const r = await db.query('SELECT name, value FROM categories ORDER BY value DESC');
    res.json(r.rows.map((row) => ({ name: row.name, value: Number(row.value) })));
  } catch (err) {
    next(err);
  }
});

app.get('/api/recent', async (req, res, next) => {
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
        createdAt: new Date(row.created_at).toISOString(),
      }))
    );
  } catch (err) {
    next(err);
  }
});

app.get('/api/settings', async (req, res, next) => {
  try {
    const db = await getDb();
    const r = await db.query('SELECT theme FROM settings WHERE id = 1');
    const theme = r.rows[0] ? r.rows[0].theme : 'light';
    res.json({ theme });
  } catch (err) {
    next(err);
  }
});

app.put('/api/settings', async (req, res, next) => {
  try {
    const { theme } = req.body || {};
    if (theme !== 'light' && theme !== 'dark') {
      return res.status(400).json({ error: "theme must be 'light' or 'dark'" });
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
const clientDist = path.join(__dirname, '..', 'client', 'dist');
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
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Metrics dashboard API listening on http://localhost:${PORT}`);
});
