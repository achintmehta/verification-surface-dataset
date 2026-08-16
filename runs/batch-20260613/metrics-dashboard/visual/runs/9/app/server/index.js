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

const db = new PGlite(path.join(process.cwd(), '.pglite-data'));

function isoDate(daysAgo) {
  const d = new Date(Date.UTC(2025, 0, 30));
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

const visitors = [1840, 2012, 1975, 2260, 2418, 2355, 2580, 2496, 2712, 2688, 2810, 2944, 3055, 2986, 3168, 3322, 3280, 3415, 3590, 3518, 3740, 3864, 3925, 4058, 4188, 4120, 4360, 4485, 4610, 4792];
const revenue = [22840, 24610, 23990, 25870, 27120, 26640, 28350, 27880, 29140, 28920, 30330, 31110, 32480, 31875, 33720, 34990, 34430, 35840, 37110, 36580, 38440, 39310, 40120, 41670, 42990, 42140, 44680, 45850, 47120, 48990];
const categories = [
  ['Subscriptions', 1285000],
  ['Marketplace', 842146],
  ['Enterprise Infrastructure & Compliance', 654320],
  ['Professional Services', 421905],
  ['Training', 238770],
  ['Support', 186430]
];
const itemNames = [
  'Northwind rollout', 'Quarterly renewal', 'API usage block', 'Compliance audit', 'Onboarding cohort',
  'Cloud migration', 'Premium support', 'Security review', 'Data export', 'Partner marketplace fee',
  'Analytics workshop', 'Storage expansion', 'SLA credit reversal', 'Team training', 'Integration package',
  'Observability add-on', 'Procurement sync', 'Incident response', 'Executive dashboard', 'Capacity reservation'
];

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      day date PRIMARY KEY,
      visitors integer NOT NULL,
      revenue numeric(12,2) NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      id serial PRIMARY KEY,
      label text NOT NULL,
      value integer NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recent_items (
      id serial PRIMARY KEY,
      name text NOT NULL,
      category text NOT NULL,
      value integer NOT NULL,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key text PRIMARY KEY,
      value text NOT NULL
    );
  `);

  const seeded = await db.query('SELECT COUNT(*)::int AS count FROM daily_metrics');
  if (Number(seeded.rows[0]?.count || 0) === 0) {
    await seedMetrics();
  } else {
    const version = await db.query("SELECT value FROM settings WHERE key = 'seed_version'");
    if (version.rows[0]?.value !== '2') {
      await db.exec('TRUNCATE daily_metrics, categories, recent_items RESTART IDENTITY');
      await seedMetrics();
    }
  }
  await db.query("INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING");
}

async function seedMetrics() {
  for (let i = 0; i < 30; i++) {
    await db.query('INSERT INTO daily_metrics (day, visitors, revenue) VALUES ($1, $2, $3)', [isoDate(29 - i), visitors[i], revenue[i]]);
  }
  for (const [label, value] of categories) {
    await db.query('INSERT INTO categories (label, value) VALUES ($1, $2)', [label, value]);
  }
  for (let i = 0; i < 20; i++) {
    const category = categories[i % categories.length][0];
    const value = 12400 + ((i * 7317) % 88000);
    const created = new Date(Date.UTC(2025, 0, 30, 16 - (i % 9), 20 + i, 0));
    created.setUTCDate(created.getUTCDate() - i);
    await db.query('INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)', [itemNames[i], category, value, created.toISOString()]);
  }
  await db.query("INSERT INTO settings (key, value) VALUES ('seed_version', '2') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
}

function asNumber(value) {
  return typeof value === 'number' ? value : Number(value);
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/summary', async (req, res, next) => {
  try {
    const totals = await db.query(`
      SELECT COALESCE(SUM(visitors),0)::int AS total_visitors,
             COALESCE(SUM(revenue),0)::float8 AS total_revenue
      FROM daily_metrics
    `);
    const best = await db.query(`
      SELECT day::text AS day, visitors, revenue::float8 AS revenue
      FROM daily_metrics
      ORDER BY revenue DESC, visitors DESC
      LIMIT 1
    `);
    const trend = await db.query(`
      WITH ordered AS (
        SELECT day, revenue::float8 AS revenue, ROW_NUMBER() OVER (ORDER BY day DESC) AS rn
        FROM daily_metrics
      ), windows AS (
        SELECT
          AVG(revenue) FILTER (WHERE rn BETWEEN 1 AND 7) AS current_avg,
          AVG(revenue) FILTER (WHERE rn BETWEEN 8 AND 14) AS previous_avg
        FROM ordered
      )
      SELECT CASE WHEN previous_avg = 0 THEN 0 ELSE ((current_avg - previous_avg) / previous_avg * 100) END::float8 AS trend_pct
      FROM windows
    `);
    res.json({
      totalVisitors: asNumber(totals.rows[0].total_visitors),
      totalRevenue: Math.round(asNumber(totals.rows[0].total_revenue) * 100) / 100,
      bestDay: best.rows[0] ? { date: best.rows[0].day, visitors: asNumber(best.rows[0].visitors), revenue: asNumber(best.rows[0].revenue) } : null,
      sevenDayTrendPct: Math.round(asNumber(trend.rows[0]?.trend_pct || 0) * 10) / 10
    });
  } catch (err) { next(err); }
});

app.get('/api/timeseries', async (req, res, next) => {
  try {
    const result = await db.query('SELECT day::text AS date, visitors, revenue::float8 AS revenue FROM daily_metrics ORDER BY day ASC');
    res.json(result.rows.map(r => ({ date: r.date, visitors: asNumber(r.visitors), revenue: asNumber(r.revenue) })));
  } catch (err) { next(err); }
});

app.get('/api/categories', async (req, res, next) => {
  try {
    const result = await db.query('SELECT label, value FROM categories ORDER BY value DESC, label ASC');
    res.json(result.rows.map(r => ({ label: r.label, value: asNumber(r.value) })));
  } catch (err) { next(err); }
});

app.get('/api/recent', async (req, res, next) => {
  try {
    const result = await db.query('SELECT name, category, value, created_at::text AS createdAt FROM recent_items ORDER BY created_at DESC LIMIT 20');
    res.json(result.rows.map(r => ({ name: r.name, category: r.category, value: asNumber(r.value), createdAt: r.createdat || r.createdAt })));
  } catch (err) { next(err); }
});

app.get('/api/settings', async (req, res, next) => {
  try {
    const result = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    const theme = result.rows[0]?.value === 'dark' ? 'dark' : 'light';
    res.json({ theme });
  } catch (err) { next(err); }
});

app.put('/api/settings', async (req, res, next) => {
  try {
    const theme = req.body?.theme;
    if (theme !== 'light' && theme !== 'dark') return res.status(400).json({ error: 'theme must be light or dark' });
    await db.query("INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [theme]);
    res.json({ theme });
  } catch (err) { next(err); }
});

const dist = path.join(process.cwd(), 'dist');
app.use(express.static(dist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(dist, 'index.html'), err => { if (err) next(); });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`Metrics API listening on http://localhost:${PORT}`));
}).catch(err => {
  console.error('Failed to initialize database', err);
  process.exit(1);
});
