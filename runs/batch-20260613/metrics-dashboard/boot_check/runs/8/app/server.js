import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(path.join(__dirname, 'pglite-data'));
const SEED_VERSION = '2025-analytics-v2';
const iso = (d) => d.toISOString().slice(0, 10);

function deterministicSeries() {
  const start = new Date(Date.UTC(2025, 0, 1));
  const rows = [];
  const noise = [44, -18, 91, -52, 28, 115, -36, 64, -72, 20, 132, -41, 76, -9, 58, -66, 103, -24, 82, -15, 141, -59, 39, 96, -31, 124, -8, 67, -48, 153];
  for (let i = 0; i < 30; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const visitors = 1180 + i * 37 + (i % 7) * 42 + noise[i];
    const revenue = Number((visitors * (18.75 + (i % 5) * 0.72) + 4200 + (i % 4) * 515).toFixed(2));
    rows.push({ date: iso(d), visitors, revenue });
  }
  return rows;
}

const categories = [
  ['Product Analytics', 428500],
  ['Enterprise Infrastructure & Compliance', 1250000],
  ['Customer Success', 318240],
  ['Mobile Acquisition', 687900],
  ['Billing Operations', 219760],
  ['Partner Enablement', 542300]
];

function recentItems() {
  const names = ['Northwind renewal', 'Latency audit', 'Quarterly rollout', 'Mobile funnel review', 'Security evidence pack', 'Usage expansion', 'Partner sync', 'Billing cleanup', 'Conversion experiment', 'Retention cohort', 'Enterprise workshop', 'API adoption', 'Forecast revision', 'Trial onboarding', 'Compliance review', 'Feature launch', 'Support insights', 'Pricing analysis', 'Executive report', 'Platform migration'];
  const rows = [];
  const base = new Date(Date.UTC(2025, 0, 30, 12, 0, 0));
  for (let i = 0; i < 20; i++) {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() - i);
    const category = categories[i % categories.length][0];
    const value = 18500 + i * 7310 + (i % 6) * 4200;
    rows.push({ name: names[i], category, value, created_at: d.toISOString() });
  }
  return rows;
}

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date TEXT PRIMARY KEY,
      visitors INTEGER NOT NULL,
      revenue NUMERIC NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      label TEXT NOT NULL UNIQUE,
      value INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      value INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const count = await db.query('SELECT COUNT(*)::int AS count FROM daily_metrics');
  const seedVersion = (await db.query("SELECT value FROM settings WHERE key = 'seed_version'")).rows[0]?.value;
  if (Number(count.rows[0].count) === 0 || seedVersion !== SEED_VERSION) {
    await db.exec('BEGIN');
    try {
      await db.query('DELETE FROM daily_metrics');
      await db.query('DELETE FROM categories');
      await db.query('DELETE FROM recent_items');
      for (const r of deterministicSeries()) {
        await db.query('INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)', [r.date, r.visitors, r.revenue]);
      }
      for (const [label, value] of categories) {
        await db.query('INSERT INTO categories (label, value) VALUES ($1, $2)', [label, value]);
      }
      for (const r of recentItems()) {
        await db.query('INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)', [r.name, r.category, r.value, r.created_at]);
      }
      await db.query("INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING");
      await db.query("INSERT INTO settings (key, value) VALUES ('seed_version', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [SEED_VERSION]);
      await db.exec('COMMIT');
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }
  } else {
    await db.query("INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING");
  }
}

function money(n) {
  return Number(Number(n).toFixed(2));
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/summary', async (_req, res, next) => {
  try {
    const metrics = (await db.query('SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC')).rows;
    const totalVisitors = metrics.reduce((sum, r) => sum + Number(r.visitors), 0);
    const totalRevenue = metrics.reduce((sum, r) => sum + Number(r.revenue), 0);
    const best = metrics.reduce((a, r) => Number(r.revenue) > Number(a.revenue) ? r : a, metrics[0]);
    const last7 = metrics.slice(-7).reduce((sum, r) => sum + Number(r.visitors), 0);
    const prev7 = metrics.slice(-14, -7).reduce((sum, r) => sum + Number(r.visitors), 0);
    const trend = prev7 ? ((last7 - prev7) / prev7) * 100 : 0;
    res.json({
      totalVisitors,
      totalRevenue: money(totalRevenue),
      bestDay: { date: best.date, visitors: Number(best.visitors), revenue: money(best.revenue) },
      sevenDayTrendPercent: Number(trend.toFixed(1))
    });
  } catch (err) { next(err); }
});

app.get('/api/timeseries', async (_req, res, next) => {
  try {
    const rows = (await db.query('SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC')).rows;
    res.json(rows.map(r => ({ date: r.date, visitors: Number(r.visitors), revenue: money(r.revenue) })));
  } catch (err) { next(err); }
});

app.get('/api/categories', async (_req, res, next) => {
  try {
    const rows = (await db.query('SELECT label, value FROM categories ORDER BY value DESC')).rows;
    res.json(rows.map(r => ({ label: r.label, value: Number(r.value) })));
  } catch (err) { next(err); }
});

app.get('/api/recent', async (_req, res, next) => {
  try {
    const rows = (await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20')).rows;
    res.json(rows.map(r => ({ name: r.name, category: r.category, value: Number(r.value), created_at: r.created_at })));
  } catch (err) { next(err); }
});

app.get('/api/settings', async (_req, res, next) => {
  try {
    const row = (await db.query("SELECT value FROM settings WHERE key = 'theme'")).rows[0];
    res.json({ theme: row?.value === 'dark' ? 'dark' : 'light' });
  } catch (err) { next(err); }
});

app.put('/api/settings', async (req, res, next) => {
  try {
    const theme = req.body?.theme;
    if (theme !== 'light' && theme !== 'dark') return res.status(400).json({ error: 'theme must be light or dark' });
    await db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', ['theme', theme]);
    res.json({ theme });
  } catch (err) { next(err); }
});

const dist = path.join(__dirname, 'dist');
app.use(express.static(dist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(dist, 'index.html'), (err) => {
    if (err) res.status(200).send('Metrics Dashboard API is running. Start Vite with npm run dev:client or build the client with npm run build.');
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`metrics-dashboard server listening on ${PORT}`));
}).catch((err) => {
  console.error('Failed to initialize database', err);
  process.exit(1);
});
