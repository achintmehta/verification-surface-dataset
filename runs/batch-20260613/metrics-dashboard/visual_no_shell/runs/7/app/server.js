import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const db = new PGlite(path.join(__dirname, 'pglite-data'));

const pad = (n) => String(n).padStart(2, '0');
const seedDates = Array.from({ length: 30 }, (_, i) => `2025-04-${pad(i + 1)}`);

async function initDb() {
  await db.query(`CREATE TABLE IF NOT EXISTS daily_metrics (
    id SERIAL PRIMARY KEY,
    day DATE UNIQUE NOT NULL,
    visitors INTEGER NOT NULL,
    revenue NUMERIC(12,2) NOT NULL
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    label TEXT UNIQUE NOT NULL,
    value INTEGER NOT NULL
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS recent_items (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    value INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS settings (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  const dailyCount = Number((await db.query('SELECT COUNT(*)::int AS count FROM daily_metrics')).rows[0].count);
  if (dailyCount === 0) {
    for (let i = 0; i < 30; i++) {
      const visitors = 31500 + i * 820 + ((i * 37) % 11) * 410 + (i % 6 === 0 ? 6200 : 0);
      const revenue = Number((visitors * (1.42 + (i % 5) * 0.11) + 9000 + (i % 4) * 1750).toFixed(2));
      await db.query('INSERT INTO daily_metrics (day, visitors, revenue) VALUES ($1, $2, $3)', [seedDates[i], visitors, revenue]);
    }
  }

  const categoryCount = Number((await db.query('SELECT COUNT(*)::int AS count FROM categories')).rows[0].count);
  if (categoryCount === 0) {
    const categories = [
      ['Enterprise Infrastructure & Compliance', 1234567],
      ['Self-service Analytics', 845320],
      ['Customer Success', 612880],
      ['Platform Operations', 488410],
      ['Growth Experiments', 356720],
      ['Partner Channels', 236540]
    ];
    for (const row of categories) await db.query('INSERT INTO categories (label, value) VALUES ($1, $2)', row);
  }

  const recentCount = Number((await db.query('SELECT COUNT(*)::int AS count FROM recent_items')).rows[0].count);
  if (recentCount === 0) {
    const cats = ['Enterprise Infrastructure & Compliance', 'Self-service Analytics', 'Customer Success', 'Platform Operations', 'Growth Experiments', 'Partner Channels'];
    for (let i = 0; i < 20; i++) {
      const value = 15200 + ((i * 7919) % 88000) + (i === 3 ? 145000 : 0);
      const created = `2025-04-${pad(30 - Math.floor(i / 2))}T${pad(16 - (i % 8))}:30:00.000Z`;
      await db.query('INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)', [
        `Metric event ${pad(i + 1)}`,
        cats[i % cats.length],
        value,
        created
      ]);
    }
  }

  await db.query("INSERT INTO settings (name, value) VALUES ('theme', 'light') ON CONFLICT (name) DO NOTHING");
}

async function getTheme() {
  const result = await db.query("SELECT value FROM settings WHERE name = 'theme'");
  return result.rows[0]?.value === 'dark' ? 'dark' : 'light';
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/summary', async (_req, res, next) => {
  try {
    const rows = (await db.query('SELECT day::text AS day, visitors, revenue::float8 AS revenue FROM daily_metrics ORDER BY day')).rows;
    const totalVisitors = rows.reduce((sum, r) => sum + Number(r.visitors), 0);
    const totalRevenue = rows.reduce((sum, r) => sum + Number(r.revenue), 0);
    const best = rows.reduce((a, b) => Number(b.visitors) > Number(a.visitors) ? b : a, rows[0]);
    const last7 = rows.slice(-7).reduce((sum, r) => sum + Number(r.visitors), 0) / 7;
    const prev7 = rows.slice(-14, -7).reduce((sum, r) => sum + Number(r.visitors), 0) / 7;
    const trendPercent = prev7 ? ((last7 - prev7) / prev7) * 100 : 0;
    res.json({
      totalVisitors,
      totalRevenue: Number(totalRevenue.toFixed(2)),
      bestDay: { date: best.day.slice(0, 10), visitors: Number(best.visitors), revenue: Number(best.revenue) },
      trendPercent: Number(trendPercent.toFixed(2))
    });
  } catch (err) { next(err); }
});

app.get('/api/timeseries', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT day::text AS date, visitors, revenue::float8 AS revenue FROM daily_metrics ORDER BY day');
    res.json(result.rows.map(r => ({ date: r.date.slice(0, 10), visitors: Number(r.visitors), revenue: Number(r.revenue) })));
  } catch (err) { next(err); }
});

app.get('/api/categories', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT label, value FROM categories ORDER BY value DESC');
    res.json(result.rows.map(r => ({ label: r.label, value: Number(r.value) })));
  } catch (err) { next(err); }
});

app.get('/api/recent', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT name, category, value, created_at::text AS created_at FROM recent_items ORDER BY created_at DESC, id DESC LIMIT 20');
    res.json(result.rows.map(r => ({ ...r, value: Number(r.value), created_at: new Date(r.created_at).toISOString() })));
  } catch (err) { next(err); }
});

app.get('/api/settings', async (_req, res, next) => {
  try { res.json({ theme: await getTheme() }); } catch (err) { next(err); }
});

app.put('/api/settings', async (req, res, next) => {
  try {
    const theme = req.body?.theme;
    if (!['light', 'dark'].includes(theme)) return res.status(400).json({ error: 'theme must be light or dark' });
    await db.query("INSERT INTO settings (name, value) VALUES ('theme', $1) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value", [theme]);
    res.json({ theme });
  } catch (err) { next(err); }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

await initDb();
app.use('/src', express.static(path.join(__dirname, 'src'), { extensions: ['js', 'css'] }));
app.use(async (_req, res, next) => {
  try {
    const theme = await getTheme();
    let html = await readFile(path.join(__dirname, 'index.html'), 'utf-8');
    html = html.replaceAll('__THEME__', theme);
    res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
  } catch (e) {
    next(e);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`metrics-dashboard running at http://localhost:${PORT}`);
});
