import express from 'express';
import cors from 'cors';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'pglite-data');
await mkdir(dataDir, { recursive: true });

const db = new PGlite(dataDir);

function isoDate(daysFromStart) {
  const start = Date.UTC(2025, 0, 1);
  return new Date(start + daysFromStart * 86400000).toISOString().slice(0, 10);
}

function seededRows() {
  const daily = [];
  for (let i = 0; i < 30; i += 1) {
    const weekdayLift = [60, 90, 120, 160, 210, -40, -80][i % 7];
    const wave = Math.round(Math.sin(i / 3.4) * 190);
    const visitors = 3450 + i * 92 + weekdayLift + wave;
    const revenue = Number((visitors * (7.15 + (i % 5) * 0.38) + 2200 + (i % 4) * 780).toFixed(2));
    daily.push({ date: isoDate(i), visitors, revenue });
  }

  const categories = [
    ['Product Analytics', 642300],
    ['Enterprise Infrastructure & Compliance', 1250000],
    ['Marketing Operations', 438920],
    ['Customer Success', 319750],
    ['Research & Development', 792100],
    ['Partner Ecosystem', 281640]
  ];

  const itemNames = [
    'Northstar conversion review', 'Pipeline source audit', 'Regional capacity model',
    'Onboarding milestone export', 'Quarterly compliance package', 'Forecast variance memo',
    'Expansion cohort analysis', 'Security controls attestation', 'Partner enablement sprint',
    'Support volume classifier', 'Data quality backfill', 'Revenue retention brief',
    'Executive KPI digest', 'Trial activation study', 'Billing reconciliation',
    'Infrastructure cost review', 'Usage anomaly report', 'Segment health snapshot',
    'Product adoption survey', 'Renewal risk worksheet'
  ];
  const recent = itemNames.map((name, i) => ({
    name,
    category: categories[i % categories.length][0],
    value: 18000 + ((i * 7919) % 87000),
    created_at: new Date(Date.UTC(2025, 0, 30, 14, 0, 0) - i * 11 * 3600000).toISOString()
  }));

  return { daily, categories, recent };
}

async function init() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      metric_date date PRIMARY KEY,
      visitors integer NOT NULL,
      revenue numeric(12,2) NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      id serial PRIMARY KEY,
      label text NOT NULL UNIQUE,
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

  const count = await db.query('SELECT COUNT(*)::int AS count FROM daily_metrics');
  if (count.rows[0].count === 0) {
    const { daily, categories, recent } = seededRows();
    await db.query('BEGIN');
    try {
      for (const row of daily) {
        await db.query('INSERT INTO daily_metrics (metric_date, visitors, revenue) VALUES ($1, $2, $3)', [row.date, row.visitors, row.revenue]);
      }
      for (const [label, value] of categories) {
        await db.query('INSERT INTO categories (label, value) VALUES ($1, $2)', [label, value]);
      }
      for (const item of recent) {
        await db.query('INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)', [item.name, item.category, item.value, item.created_at]);
      }
      await db.query("INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING");
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  }

  await db.query("INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING");
}

await init();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, '..', 'dist'), { fallthrough: true }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/summary', async (_req, res, next) => {
  try {
    const totals = await db.query('SELECT SUM(visitors)::int AS visitors, SUM(revenue)::float8 AS revenue FROM daily_metrics');
    const best = await db.query('SELECT metric_date::text AS date, visitors, revenue::float8 AS revenue FROM daily_metrics ORDER BY revenue DESC LIMIT 1');
    const trend = await db.query(`
      WITH ranked AS (
        SELECT visitors, ROW_NUMBER() OVER (ORDER BY metric_date DESC) AS rn FROM daily_metrics
      ), sums AS (
        SELECT
          SUM(CASE WHEN rn BETWEEN 1 AND 7 THEN visitors ELSE 0 END)::float8 AS current_7,
          SUM(CASE WHEN rn BETWEEN 8 AND 14 THEN visitors ELSE 0 END)::float8 AS previous_7
        FROM ranked
      )
      SELECT CASE WHEN previous_7 = 0 THEN 0 ELSE ((current_7 - previous_7) / previous_7) * 100 END AS trend_pct FROM sums
    `);

    res.json({
      totalVisitors: totals.rows[0].visitors,
      totalRevenue: Number(totals.rows[0].revenue.toFixed(2)),
      bestDay: best.rows[0],
      sevenDayTrendPct: Number(trend.rows[0].trend_pct.toFixed(1))
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/timeseries', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT metric_date::text AS date, visitors, revenue::float8 AS revenue FROM daily_metrics ORDER BY metric_date');
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

app.get('/api/categories', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT label, value FROM categories ORDER BY value DESC');
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

app.get('/api/recent', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT id, name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20');
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

app.get('/api/settings', async (_req, res, next) => {
  try {
    const result = await db.query("SELECT value AS theme FROM settings WHERE key = 'theme'");
    res.json({ theme: result.rows[0]?.theme === 'dark' ? 'dark' : 'light' });
  } catch (error) {
    next(error);
  }
});

app.put('/api/settings', async (req, res, next) => {
  try {
    const { theme } = req.body ?? {};
    if (!['light', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    await db.query("INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [theme]);
    res.json({ theme });
  } catch (error) {
    next(error);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, '..', 'dist', 'index.html'));
});

app.listen(port, () => {
  console.log(`Metrics API listening on http://localhost:${port}`);
});
