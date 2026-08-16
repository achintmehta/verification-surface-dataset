import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'pglite-data');
const clientDist = path.join(rootDir, 'dist');
const PORT = process.env.PORT || 3000;

await mkdir(dataDir, { recursive: true });
const db = new PGlite(dataDir);

const app = express();
app.use(cors());
app.use(express.json());

function isoDateOffset(daysAgo) {
  const base = new Date(Date.UTC(2025, 0, 30));
  base.setUTCDate(base.getUTCDate() - daysAgo);
  return base.toISOString().slice(0, 10);
}

function isoDateTimeOffset(hoursAgo) {
  const base = new Date(Date.UTC(2025, 0, 30, 12, 0, 0));
  base.setUTCHours(base.getUTCHours() - hoursAgo);
  return base.toISOString();
}

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
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

  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM daily_metrics');
  if (rows[0].count === 0) {
    await seedDb();
  }

  await db.query(
    `INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING`
  );
}

async function seedDb() {
  const visitors = [
    32780, 34120, 33890, 35240, 36780, 36110, 37990, 38450, 37220, 39140,
    40210, 41480, 40960, 42130, 43880, 43210, 44650, 45990, 45120, 46780,
    48240, 47610, 49120, 50880, 49770, 51540, 52990, 52230, 54180, 55840
  ];
  const revenue = [
    84210.35, 86940.1, 85880.7, 89250.55, 93410.2, 91875.9, 96770.45, 97820.0,
    95140.6, 99735.42, 102190.3, 105870.15, 104480.95, 107640.8, 112945.1,
    110430.25, 113880.4, 117210.7, 115690.55, 119760.9, 123450.2, 121870.0,
    125630.35, 130240.6, 127650.45, 132110.8, 135640.2, 133780.1, 138450.75,
    142990.3
  ];

  await db.transaction(async (tx) => {
    for (let i = 0; i < visitors.length; i++) {
      await tx.query(
        'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
        [isoDateOffset(29 - i), visitors[i], revenue[i]]
      );
    }

    const cats = [
      ['Acquisition', 854320],
      ['Retention', 632450],
      ['Enterprise Infrastructure & Compliance', 1245789],
      ['Self-Service Analytics', 489120],
      ['Partner Channel', 718930],
      ['Support Operations', 362870]
    ];
    for (const [label, value] of cats) {
      await tx.query('INSERT INTO categories (label, value) VALUES ($1, $2)', [label, value]);
    }

    const itemCategories = cats.map((c) => c[0]);
    for (let i = 0; i < 20; i++) {
      await tx.query(
        'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
        [
          `Metric event ${String(i + 1).padStart(2, '0')}`,
          itemCategories[(i * 2 + 1) % itemCategories.length],
          12850 + ((i * 7919) % 87500),
          isoDateTimeOffset(i * 11)
        ]
      );
    }
  });
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/api/summary', asyncHandler(async (req, res) => {
  const totals = await db.query(`
    SELECT
      COALESCE(SUM(visitors), 0)::int AS total_visitors,
      COALESCE(SUM(revenue), 0)::float8 AS total_revenue
    FROM daily_metrics
  `);
  const best = await db.query(`
    SELECT date::text, visitors, revenue::float8
    FROM daily_metrics
    ORDER BY revenue DESC
    LIMIT 1
  `);
  const trend = await db.query(`
    WITH ordered AS (
      SELECT date, visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
      FROM daily_metrics
    ), recent AS (
      SELECT AVG(visitors)::float8 AS avg_v FROM ordered WHERE rn BETWEEN 1 AND 7
    ), previous AS (
      SELECT AVG(visitors)::float8 AS avg_v FROM ordered WHERE rn BETWEEN 8 AND 14
    )
    SELECT CASE WHEN previous.avg_v = 0 OR previous.avg_v IS NULL THEN 0
      ELSE ((recent.avg_v - previous.avg_v) / previous.avg_v * 100)::float8 END AS trend
    FROM recent, previous
  `);

  res.json({
    totalVisitors: totals.rows[0].total_visitors,
    totalRevenue: Number(totals.rows[0].total_revenue.toFixed(2)),
    bestDay: best.rows[0] ? { date: best.rows[0].date.slice(0, 10), visitors: best.rows[0].visitors, revenue: best.rows[0].revenue } : null,
    sevenDayTrendPct: Number((trend.rows[0]?.trend ?? 0).toFixed(2))
  });
}));

app.get('/api/timeseries', asyncHandler(async (req, res) => {
  const { rows } = await db.query(`
    SELECT date::text, visitors, revenue::float8
    FROM daily_metrics
    ORDER BY date ASC
  `);
  res.json(rows.map((r) => ({ ...r, date: r.date.slice(0, 10) })));
}));

app.get('/api/categories', asyncHandler(async (req, res) => {
  const { rows } = await db.query('SELECT label, value FROM categories ORDER BY value DESC');
  res.json(rows);
}));

app.get('/api/recent', asyncHandler(async (req, res) => {
  const { rows } = await db.query(`
    SELECT name, category, value, created_at
    FROM recent_items
    ORDER BY created_at DESC
    LIMIT 20
  `);
  res.json(rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() })));
}));

app.get('/api/settings', asyncHandler(async (req, res) => {
  const { rows } = await db.query("SELECT value FROM settings WHERE key = 'theme'");
  const theme = rows[0]?.value === 'dark' ? 'dark' : 'light';
  res.json({ theme });
}));

app.put('/api/settings', asyncHandler(async (req, res) => {
  const theme = req.body?.theme;
  if (theme !== 'light' && theme !== 'dark') {
    return res.status(400).json({ error: 'theme must be light or dark' });
  }
  await db.query(
    "INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [theme]
  );
  res.json({ theme });
}));

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(clientDist));
  app.get(/.*/, (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

await initDb();
app.listen(PORT, () => {
  console.log(`Metrics dashboard API listening on http://localhost:${PORT}`);
});
