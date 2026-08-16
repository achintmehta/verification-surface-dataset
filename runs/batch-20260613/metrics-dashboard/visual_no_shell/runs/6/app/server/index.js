import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 3001;

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());
app.use('/src', express.static(path.join(ROOT, 'src')));
app.use(express.static(ROOT));

const db = new PGlite(path.join(ROOT, 'data', 'pglite'));

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function initDb() {
  await db.query(`CREATE TABLE IF NOT EXISTS daily_metrics (
    day DATE PRIMARY KEY,
    visitors INTEGER NOT NULL,
    revenue NUMERIC(12,2) NOT NULL
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    label TEXT NOT NULL UNIQUE,
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
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  const dailyCount = await db.query('SELECT COUNT(*)::int AS count FROM daily_metrics');
  if ((dailyCount.rows[0]?.count ?? 0) === 0) {
    const start = new Date(Date.UTC(2025, 0, 1));
    const visitorOffsets = [0, 140, -72, 186, 92, -35, 226, 310, 126, 54, 284, 372, 198, 118, 420, 486, 248, 176, 344, 528, 406, 214, 292, 610, 458, 536, 320, 694, 588, 742];
    const revenueOffsets = [0, 4100, -1850, 5100, 2600, -900, 6200, 7800, 3500, 1400, 7100, 9300, 5200, 2800, 10800, 12400, 6800, 4300, 8900, 13900, 11200, 5700, 7600, 16800, 12100, 14700, 8200, 18600, 15900, 21100];
    for (let i = 0; i < 30; i++) {
      const day = new Date(start);
      day.setUTCDate(start.getUTCDate() + i);
      const visitors = 1820 + i * 47 + visitorOffsets[i];
      const revenue = 31500 + i * 815 + revenueOffsets[i];
      await db.query('INSERT INTO daily_metrics (day, visitors, revenue) VALUES ($1, $2, $3)', [isoDate(day), visitors, revenue]);
    }
  }

  const catCount = await db.query('SELECT COUNT(*)::int AS count FROM categories');
  if ((catCount.rows[0]?.count ?? 0) === 0) {
    const cats = [
      ['Platform Subscriptions', 925000],
      ['Enterprise Infrastructure & Compliance', 1250000],
      ['Professional Services', 485000],
      ['Training & Enablement', 220000],
      ['Marketplace Add-ons', 345000],
      ['Support Renewals', 675000]
    ];
    for (const c of cats) await db.query('INSERT INTO categories (label, value) VALUES ($1, $2)', c);
  }

  const recentCount = await db.query('SELECT COUNT(*)::int AS count FROM recent_items');
  if ((recentCount.rows[0]?.count ?? 0) === 0) {
    const categories = ['Platform Subscriptions', 'Enterprise Infrastructure & Compliance', 'Professional Services', 'Training & Enablement', 'Marketplace Add-ons', 'Support Renewals'];
    const names = ['Acme renewal', 'Northwind expansion', 'Globex onboarding', 'Umbrella controls', 'Initech seats', 'Hooli marketplace', 'Soylent training', 'Stark platform', 'Wayne support', 'Wonka services', 'Vandelay import', 'Massive Dynamic rollout', 'Cyberdyne license', 'Aperture enablement', 'Tyrell compliance', 'Initrode add-ons', 'Prestige upgrade', 'Oceanic support', 'Vehement capital review', 'Monarch analytics'];
    const base = new Date(Date.UTC(2025, 0, 30, 15, 0, 0));
    for (let i = 0; i < 20; i++) {
      const created = new Date(base);
      created.setUTCDate(base.getUTCDate() - i);
      created.setUTCHours(15 - (i % 6));
      const value = 8200 + ((i * 7919) % 72000) + (i % 5) * 3500;
      await db.query('INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)', [names[i], categories[i % categories.length], value, created.toISOString()]);
    }
  }

  await db.query("INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING");
}

function toNumber(value) { return typeof value === 'number' ? value : Number(value); }

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/summary', async (_req, res, next) => {
  try {
    const totals = await db.query('SELECT SUM(visitors)::int AS total_visitors, SUM(revenue)::float8 AS total_revenue FROM daily_metrics');
    const best = await db.query('SELECT day::text AS date, visitors, revenue::float8 AS revenue FROM daily_metrics ORDER BY revenue DESC, visitors DESC LIMIT 1');
    const series = await db.query('SELECT visitors FROM daily_metrics ORDER BY day DESC LIMIT 14');
    const latest7 = series.rows.slice(0, 7).reduce((s, r) => s + toNumber(r.visitors), 0);
    const previous7 = series.rows.slice(7, 14).reduce((s, r) => s + toNumber(r.visitors), 0);
    const trend = previous7 ? ((latest7 - previous7) / previous7) * 100 : 0;
    res.json({
      totalVisitors: toNumber(totals.rows[0].total_visitors),
      totalRevenue: Math.round(toNumber(totals.rows[0].total_revenue)),
      bestDay: {
        date: best.rows[0].date,
        visitors: toNumber(best.rows[0].visitors),
        revenue: Math.round(toNumber(best.rows[0].revenue))
      },
      sevenDayTrendPct: Number(trend.toFixed(1))
    });
  } catch (err) { next(err); }
});

app.get('/api/timeseries', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT day::text AS date, visitors, revenue::float8 AS revenue FROM daily_metrics ORDER BY day ASC');
    res.json(result.rows.map(r => ({ date: r.date, visitors: toNumber(r.visitors), revenue: Math.round(toNumber(r.revenue)) })));
  } catch (err) { next(err); }
});

app.get('/api/categories', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT label, value FROM categories ORDER BY value DESC');
    res.json(result.rows.map(r => ({ label: r.label, value: toNumber(r.value) })));
  } catch (err) { next(err); }
});

app.get('/api/recent', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20');
    res.json(result.rows.map(r => ({ name: r.name, category: r.category, value: toNumber(r.value), createdAt: new Date(r.created_at).toISOString() })));
  } catch (err) { next(err); }
});

app.get('/api/settings', async (_req, res, next) => {
  try {
    const result = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    res.json({ theme: result.rows[0]?.value === 'dark' ? 'dark' : 'light' });
  } catch (err) { next(err); }
});

app.put('/api/settings', async (req, res, next) => {
  try {
    const theme = req.body?.theme;
    if (!['light', 'dark'].includes(theme)) return res.status(400).json({ error: 'theme must be light or dark' });
    await db.query("INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [theme]);
    res.json({ theme });
  } catch (err) { next(err); }
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(ROOT, 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

await initDb();
app.listen(PORT, () => console.log(`Metrics dashboard listening on http://localhost:${PORT}`));
