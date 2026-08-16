import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'pglite-data');
const port = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(dataDir);

function moneyRound(value) {
  return Math.round(value * 100) / 100;
}

function isoDay(offsetFromStart) {
  const start = new Date(Date.UTC(2025, 0, 1));
  start.setUTCDate(start.getUTCDate() + offsetFromStart);
  return start.toISOString().slice(0, 10);
}

function itemDate(index) {
  const d = new Date(Date.UTC(2025, 0, 30, 12, 0, 0));
  d.setUTCDate(d.getUTCDate() - index);
  d.setUTCHours(9 + (index % 9), (index * 7) % 60, 0, 0);
  return d.toISOString();
}

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      day DATE PRIMARY KEY,
      visitors INTEGER NOT NULL,
      revenue NUMERIC(12,2) NOT NULL
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
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const countResult = await db.query('SELECT COUNT(*)::int AS count FROM daily_metrics');
  const count = countResult.rows[0]?.count ?? 0;
  if (count === 0) {
    const daily = [];
    for (let i = 0; i < 30; i++) {
      const visitors = 1550 + i * 47 + ((i * 37) % 280) + (i % 6 === 0 ? 430 : 0) - (i % 11 === 0 ? 180 : 0);
      const revenue = moneyRound(32600 + i * 415 + ((i * 97) % 1900) + (i % 5 === 0 ? 2250 : 0));
      daily.push({ day: isoDay(i), visitors, revenue });
    }
    for (const row of daily) {
      await db.query('INSERT INTO daily_metrics (day, visitors, revenue) VALUES ($1, $2, $3)', [row.day, row.visitors, row.revenue]);
    }

    const categories = [
      ['Acquisition', 872340],
      ['Retention', 642180],
      ['Enterprise Infrastructure & Compliance', 1287350],
      ['Product Analytics', 418920],
      ['Support Operations', 219760],
      ['Partner Channel', 531440]
    ];
    for (const [label, value] of categories) {
      await db.query('INSERT INTO categories (label, value) VALUES ($1, $2)', [label, value]);
    }

    const itemCategories = categories.map(([label]) => label);
    for (let i = 0; i < 20; i++) {
      const category = itemCategories[(i * 3 + 1) % itemCategories.length];
      const value = 12400 + ((i * 7919) % 96000) + (i === 3 ? 1000000 : 0);
      await db.query(
        'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
        [`Account ${String.fromCharCode(65 + i)}${1000 + i * 17}`, category, value, itemDate(i)]
      );
    }
  }

  await db.query(`INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING`);
}

function toNumber(value) {
  return typeof value === 'number' ? value : Number(value);
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/summary', async (_req, res, next) => {
  try {
    const totals = await db.query(`
      SELECT
        COALESCE(SUM(visitors), 0)::int AS total_visitors,
        COALESCE(SUM(revenue), 0)::float8 AS total_revenue
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
        SELECT day, visitors, ROW_NUMBER() OVER (ORDER BY day DESC) AS rn
        FROM daily_metrics
      ), periods AS (
        SELECT
          SUM(CASE WHEN rn BETWEEN 1 AND 7 THEN visitors ELSE 0 END)::float8 AS recent,
          SUM(CASE WHEN rn BETWEEN 8 AND 14 THEN visitors ELSE 0 END)::float8 AS previous
        FROM ordered
      )
      SELECT CASE WHEN previous = 0 THEN 0 ELSE ((recent - previous) / previous * 100) END::float8 AS trend_percent
      FROM periods
    `);

    res.json({
      totalVisitors: toNumber(totals.rows[0].total_visitors),
      totalRevenue: moneyRound(toNumber(totals.rows[0].total_revenue)),
      bestDay: {
        date: best.rows[0]?.day,
        visitors: toNumber(best.rows[0]?.visitors ?? 0),
        revenue: moneyRound(toNumber(best.rows[0]?.revenue ?? 0))
      },
      sevenDayTrend: moneyRound(toNumber(trend.rows[0]?.trend_percent ?? 0))
    });
  } catch (err) { next(err); }
});

app.get('/api/timeseries', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT day::text AS date, visitors, revenue::float8 AS revenue FROM daily_metrics ORDER BY day');
    res.json(result.rows.map(r => ({ date: r.date, visitors: toNumber(r.visitors), revenue: moneyRound(toNumber(r.revenue)) })));
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
    const theme = result.rows[0]?.value === 'dark' ? 'dark' : 'light';
    res.json({ theme });
  } catch (err) { next(err); }
});

app.put('/api/settings', async (req, res, next) => {
  try {
    const theme = req.body?.theme;
    if (!['light', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'theme must be light or dark' });
    }
    await db.query("INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [theme]);
    res.json({ theme });
  } catch (err) { next(err); }
});

app.use(express.static(path.join(rootDir, 'client')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(rootDir, 'client', 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

initDb().then(() => {
  app.listen(port, () => console.log(`metrics dashboard server listening on ${port}`));
}).catch(err => {
  console.error('Failed to initialize database', err);
  process.exit(1);
});
