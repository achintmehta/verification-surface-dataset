import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import { getDb } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

// --- API routes ---

app.get('/api/summary', async (req, res, next) => {
  try {
    const db = await getDb();
    const totals = await db.query(
      'SELECT COALESCE(SUM(visitors),0)::int AS total_visitors, COALESCE(SUM(revenue),0)::bigint AS total_revenue FROM daily_metrics'
    );
    const best = await db.query(
      'SELECT day, revenue FROM daily_metrics ORDER BY revenue DESC, day DESC LIMIT 1'
    );
    // 7-day trend: sum of last 7 days vs previous 7 days (by revenue)
    const series = await db.query('SELECT revenue FROM daily_metrics ORDER BY day ASC');
    const rev = series.rows.map((r) => r.revenue);
    const last7 = rev.slice(-7).reduce((a, b) => a + b, 0);
    const prev7 = rev.slice(-14, -7).reduce((a, b) => a + b, 0);
    const trendPct = prev7 === 0 ? 0 : ((last7 - prev7) / prev7) * 100;

    res.json({
      totalVisitors: totals.rows[0].total_visitors,
      totalRevenue: Number(totals.rows[0].total_revenue),
      bestDay: best.rows[0]
        ? { day: best.rows[0].day, revenue: best.rows[0].revenue }
        : null,
      trendPct: Math.round(trendPct * 10) / 10
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/timeseries', async (req, res, next) => {
  try {
    const db = await getDb();
    const r = await db.query(
      'SELECT day, visitors, revenue FROM daily_metrics ORDER BY day ASC'
    );
    res.json(
      r.rows.map((row) => ({
        day: typeof row.day === 'string' ? row.day : new Date(row.day).toISOString().slice(0, 10),
        visitors: row.visitors,
        revenue: row.revenue
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
        value: row.value,
        createdAt:
          typeof row.created_at === 'string'
            ? row.created_at
            : new Date(row.created_at).toISOString()
      }))
    );
  } catch (err) {
    next(err);
  }
});

app.get('/api/settings', async (req, res, next) => {
  try {
    const db = await getDb();
    const r = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    res.json({ theme: r.rows[0] ? r.rows[0].value : 'light' });
  } catch (err) {
    next(err);
  }
});

app.put('/api/settings', async (req, res, next) => {
  try {
    const { theme } = req.body || {};
    if (theme !== 'light' && theme !== 'dark') {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    const db = await getDb();
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('theme', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [theme]
    );
    res.json({ theme });
  } catch (err) {
    next(err);
  }
});

// --- Serve built frontend (production) ---
const distDir = join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(join(distDir, 'index.html'));
  });
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});
