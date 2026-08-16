import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const PORT = process.env.PORT || 3000;
const db = new PGlite(process.env.PGLITE_DATA_DIR || './.pglite-data');

function isoDate(offset) {
  const d = new Date(Date.UTC(2025, 0, 1 + offset));
  return d.toISOString().slice(0, 10);
}

function seededRows() {
  const visitors = [32540, 34180, 31970, 36520, 38210, 40120, 39740, 42080, 43760, 41890, 45620, 47150, 48920, 46220, 50140, 52320, 54880, 53160, 56740, 58910, 60140, 62380, 61720, 64650, 66890, 69220, 71840, 73610, 75980, 78240];
  const revenue = [28450, 30120, 27680, 32990, 35110, 37480, 36340, 39620, 41250, 38990, 43110, 44820, 46670, 43980, 48220, 50440, 52990, 51120, 55130, 57260, 59110, 61520, 60330, 64290, 66870, 69110, 72420, 74680, 77150, 79880];
  return visitors.map((v, i) => ({ date: isoDate(i), visitors: v, revenue: revenue[i] }));
}

const categories = [
  ['Enterprise Infrastructure & Compliance', 1250000],
  ['Product Analytics', 820000],
  ['Conversion Programs', 642000],
  ['Customer Success', 438500],
  ['Partner Channels', 316750],
  ['Experimental Labs', 178900]
];

const itemNames = [
  'Northstar rollout', 'Expansion cohort', 'Self-serve upgrade', 'Compliance package',
  'Workspace migration', 'Retention campaign', 'Partner referral', 'Lifecycle audit',
  'Data pipeline tune-up', 'Premium onboarding', 'Usage milestone', 'Forecast review',
  'Security enablement', 'Executive dashboard', 'Regional launch', 'Trial acceleration',
  'Contract refresh', 'Insights workshop', 'Automation pilot', 'Quarterly business review'
];

async function initializeDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      metric_date DATE PRIMARY KEY,
      visitors INTEGER NOT NULL,
      revenue INTEGER NOT NULL
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

  const count = await db.query('SELECT COUNT(*)::int AS count FROM daily_metrics');
  if (count.rows[0].count === 0) {
    for (const row of seededRows()) {
      await db.query('INSERT INTO daily_metrics (metric_date, visitors, revenue) VALUES ($1, $2, $3)', [row.date, row.visitors, row.revenue]);
    }

    for (const [label, value] of categories) {
      await db.query('INSERT INTO categories (label, value) VALUES ($1, $2)', [label, value]);
    }

    for (let i = 0; i < itemNames.length; i++) {
      const cat = categories[i % categories.length][0];
      const value = 12000 + ((i * 7919) % 88000);
      const created = new Date(Date.UTC(2025, 0, 30 - i, 10 + (i % 9), (i * 7) % 60, 0)).toISOString();
      await db.query('INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)', [itemNames[i], cat, value, created]);
    }
  }

  await db.query("INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING");
}

function parseNumber(value) {
  return typeof value === 'number' ? value : Number(value);
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/summary', async (_req, res, next) => {
  try {
    const totals = await db.query(`
      SELECT COALESCE(SUM(visitors), 0)::int AS total_visitors,
             COALESCE(SUM(revenue), 0)::int AS total_revenue
      FROM daily_metrics
    `);
    const best = await db.query(`
      SELECT metric_date::text AS date, visitors, revenue
      FROM daily_metrics
      ORDER BY visitors DESC, metric_date ASC
      LIMIT 1
    `);
    const trend = await db.query(`
      WITH ordered AS (
        SELECT metric_date, visitors, ROW_NUMBER() OVER (ORDER BY metric_date DESC) AS rn
        FROM daily_metrics
      ), periods AS (
        SELECT
          SUM(CASE WHEN rn BETWEEN 1 AND 7 THEN visitors ELSE 0 END)::float AS this_week,
          SUM(CASE WHEN rn BETWEEN 8 AND 14 THEN visitors ELSE 0 END)::float AS last_week
        FROM ordered
      )
      SELECT CASE WHEN last_week = 0 THEN 0 ELSE ROUND(((this_week - last_week) / last_week) * 1000) / 10 END AS trend_pct
      FROM periods
    `);

    res.json({
      totalVisitors: parseNumber(totals.rows[0].total_visitors),
      totalRevenue: parseNumber(totals.rows[0].total_revenue),
      bestDay: {
        date: best.rows[0]?.date,
        visitors: parseNumber(best.rows[0]?.visitors || 0),
        revenue: parseNumber(best.rows[0]?.revenue || 0)
      },
      sevenDayTrendPct: parseNumber(trend.rows[0]?.trend_pct || 0)
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/timeseries', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT metric_date::text AS date, visitors, revenue FROM daily_metrics ORDER BY metric_date ASC');
    res.json(result.rows.map((r) => ({ date: r.date, visitors: parseNumber(r.visitors), revenue: parseNumber(r.revenue) })));
  } catch (error) {
    next(error);
  }
});

app.get('/api/categories', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT label, value FROM categories ORDER BY value DESC');
    res.json(result.rows.map((r) => ({ label: r.label, value: parseNumber(r.value) })));
  } catch (error) {
    next(error);
  }
});

app.get('/api/recent', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT name, category, value, created_at::text AS created_at FROM recent_items ORDER BY created_at DESC LIMIT 20');
    res.json(result.rows.map((r) => ({ name: r.name, category: r.category, value: parseNumber(r.value), createdAt: r.created_at })));
  } catch (error) {
    next(error);
  }
});

app.get('/api/settings', async (_req, res, next) => {
  try {
    const result = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    const theme = result.rows[0]?.value === 'dark' ? 'dark' : 'light';
    res.json({ theme });
  } catch (error) {
    next(error);
  }
});

app.put('/api/settings', async (req, res, next) => {
  try {
    const theme = req.body?.theme;
    if (theme !== 'light' && theme !== 'dark') {
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

await initializeDatabase();
app.listen(PORT, () => {
  console.log(`Metrics API listening on http://localhost:${PORT}`);
});
