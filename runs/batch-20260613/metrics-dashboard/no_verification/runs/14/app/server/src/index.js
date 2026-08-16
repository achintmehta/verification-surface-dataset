import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

// ---- API: summary ---------------------------------------------------------
app.get('/api/summary', async (req, res, next) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(
      `SELECT day, visitors, revenue FROM daily_metrics ORDER BY day ASC`
    );
    if (rows.length === 0) {
      return res.json({
        totalVisitors: 0,
        totalRevenue: 0,
        bestDay: null,
        bestDayVisitors: 0,
        trendPct: 0,
      });
    }

    const totalVisitors = rows.reduce((a, r) => a + Number(r.visitors), 0);
    const totalRevenue = rows.reduce((a, r) => a + Number(r.revenue), 0);

    let best = rows[0];
    for (const r of rows) {
      if (Number(r.visitors) > Number(best.visitors)) best = r;
    }

    // 7-day trend: sum of last 7 days vs the previous 7 days (visitors)
    const last7 = rows.slice(-7).reduce((a, r) => a + Number(r.visitors), 0);
    const prev7 = rows.slice(-14, -7).reduce((a, r) => a + Number(r.visitors), 0);
    const trendPct = prev7 > 0 ? ((last7 - prev7) / prev7) * 100 : 0;

    res.json({
      totalVisitors,
      totalRevenue,
      bestDay: typeof best.day === 'string' ? best.day.slice(0, 10) : new Date(best.day).toISOString().slice(0, 10),
      bestDayVisitors: Number(best.visitors),
      trendPct: Math.round(trendPct * 10) / 10,
    });
  } catch (err) {
    next(err);
  }
});

// ---- API: timeseries ------------------------------------------------------
app.get('/api/timeseries', async (req, res, next) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(
      `SELECT day, visitors, revenue FROM daily_metrics ORDER BY day ASC`
    );
    res.json(
      rows.map((r) => ({
        day: typeof r.day === 'string' ? r.day.slice(0, 10) : new Date(r.day).toISOString().slice(0, 10),
        visitors: Number(r.visitors),
        revenue: Number(r.revenue),
      }))
    );
  } catch (err) {
    next(err);
  }
});

// ---- API: categories ------------------------------------------------------
app.get('/api/categories', async (req, res, next) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(
      `SELECT name, value FROM categories ORDER BY value DESC`
    );
    res.json(rows.map((r) => ({ name: r.name, value: Number(r.value) })));
  } catch (err) {
    next(err);
  }
});

// ---- API: recent ----------------------------------------------------------
app.get('/api/recent', async (req, res, next) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(
      `SELECT name, category, value, created_at
       FROM recent_items ORDER BY created_at DESC`
    );
    res.json(
      rows.map((r) => ({
        name: r.name,
        category: r.category,
        value: Number(r.value),
        createdAt: typeof r.created_at === 'string' ? r.created_at : new Date(r.created_at).toISOString(),
      }))
    );
  } catch (err) {
    next(err);
  }
});

// ---- API: settings --------------------------------------------------------
app.get('/api/settings', async (req, res, next) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'theme'`);
    const theme = rows.length ? rows[0].value : 'light';
    res.json({ theme });
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
      `INSERT INTO settings (key, value) VALUES ('theme', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [theme]
    );
    res.json({ theme });
  } catch (err) {
    next(err);
  }
});

// ---- Optionally serve the built client ------------------------------------
const clientDist = path.resolve(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// ---- Error handler --------------------------------------------------------
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

getDb()
  .then(() => {
    app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`Metrics dashboard API listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
