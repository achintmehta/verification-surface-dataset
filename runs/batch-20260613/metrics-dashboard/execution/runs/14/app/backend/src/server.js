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

// ---------------- API ----------------

app.get('/api/summary', async (req, res) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, visitors, revenue::float8 AS revenue
      FROM daily_metrics
      ORDER BY day ASC
    `);
    if (rows.length === 0) return res.json(emptySummary());

    const totalVisitors = rows.reduce((s, r) => s + r.visitors, 0);
    const totalRevenue = rows.reduce((s, r) => s + Number(r.revenue), 0);

    // best day = day with highest visitors
    let best = rows[0];
    for (const r of rows) if (r.visitors > best.visitors) best = r;

    // 7-day trend %: sum visitors of last 7 days vs the prior 7 days
    const n = rows.length;
    const last7 = rows.slice(Math.max(0, n - 7)).reduce((s, r) => s + r.visitors, 0);
    const prev7 = rows.slice(Math.max(0, n - 14), Math.max(0, n - 7)).reduce((s, r) => s + r.visitors, 0);
    let trendPct = 0;
    if (prev7 > 0) trendPct = ((last7 - prev7) / prev7) * 100;

    res.json({
      totalVisitors,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      bestDay: { day: best.day, visitors: best.visitors },
      trendPct: Math.round(trendPct * 10) / 10,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute summary' });
  }
});

function emptySummary() {
  return { totalVisitors: 0, totalRevenue: 0, bestDay: { day: null, visitors: 0 }, trendPct: 0 };
}

app.get('/api/timeseries', async (req, res) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, visitors, revenue::float8 AS revenue
      FROM daily_metrics
      ORDER BY day ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load timeseries' });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(`
      SELECT id, name, value::float8 AS value
      FROM categories
      ORDER BY value DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load categories' });
  }
});

app.get('/api/recent', async (req, res) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(`
      SELECT id, name, category, value::float8 AS value,
             to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
      FROM recent_items
      ORDER BY created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load recent items' });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const db = await getDb();
    const { rows } = await db.query('SELECT theme FROM settings WHERE id = 1');
    res.json({ theme: rows[0]?.theme || 'light' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const theme = req.body?.theme;
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
    console.error(err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// ---------------- Static frontend (production) ----------------
const distDir = path.resolve(__dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Metrics dashboard API listening on http://localhost:${PORT}`);
});
