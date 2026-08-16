import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', 'pglite-data');

const db = new PGlite(DATA_DIR);

function money(value) {
  return Math.round(value * 100) / 100;
}

function seededDailyMetrics() {
  const rows = [];
  const start = new Date('2025-01-01T00:00:00Z');
  for (let i = 0; i < 30; i += 1) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + i);
    const visitors = 1050 + i * 31 + ((i * 47) % 290) + (i % 6 === 0 ? 420 : 0);
    const revenue = money(28000 + visitors * 8.75 + ((i * 113) % 1700));
    rows.push({ date: date.toISOString().slice(0, 10), visitors, revenue });
  }
  return rows;
}

const categories = [
  { label: 'Enterprise Infrastructure & Compliance', value: 1284736 },
  { label: 'Product Analytics', value: 842360 },
  { label: 'Marketing Operations', value: 674250 },
  { label: 'Customer Success', value: 418900 },
  { label: 'Self-Service Growth', value: 332480 },
  { label: 'Partner Channel', value: 219760 },
];

const recentNames = [
  'Northstar renewal', 'Pipeline acceleration', 'Trial cohort audit', 'Data warehouse sync',
  'Regional launch', 'Executive scorecard', 'Retention review', 'Forecast refresh',
  'Compliance export', 'Expansion analysis', 'Usage anomaly', 'Onboarding sprint',
  'Partner enablement', 'Revenue reconciliation', 'Segment refresh', 'Quality review',
  'Win-back campaign', 'Quarterly planning', 'Support insights', 'Board package'
];

async function initializeDatabase() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      metric_date DATE NOT NULL UNIQUE,
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
  const alreadySeeded = Number(countResult.rows[0]?.count || 0) > 0;
  if (!alreadySeeded) {
    await db.query('BEGIN');
    try {
      for (const row of seededDailyMetrics()) {
        await db.query(
          'INSERT INTO daily_metrics (metric_date, visitors, revenue) VALUES ($1, $2, $3)',
          [row.date, row.visitors, row.revenue]
        );
      }
      for (const category of categories) {
        await db.query('INSERT INTO categories (label, value) VALUES ($1, $2)', [category.label, category.value]);
      }
      const base = new Date('2025-01-30T14:30:00Z');
      for (let i = 0; i < 20; i += 1) {
        const created = new Date(base);
        created.setUTCHours(base.getUTCHours() - i * 9);
        const category = categories[i % categories.length].label;
        const value = 18000 + ((i * 7919) % 87000) + (i === 3 ? 1000000 : 0);
        await db.query(
          'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
          [recentNames[i], category, value, created.toISOString()]
        );
      }
      await db.query("INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING");
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  } else {
    await db.query("INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING");
  }
}

function asNumber(value) {
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
             COALESCE(SUM(revenue), 0)::numeric(12,2) AS total_revenue
      FROM daily_metrics
    `);
    const best = await db.query(`
      SELECT metric_date::text AS date, visitors, revenue::numeric(12,2) AS revenue
      FROM daily_metrics
      ORDER BY visitors DESC, revenue DESC
      LIMIT 1
    `);
    const daily = await db.query('SELECT visitors FROM daily_metrics ORDER BY metric_date DESC LIMIT 14');
    const last7 = daily.rows.slice(0, 7).reduce((sum, row) => sum + asNumber(row.visitors), 0);
    const previous7 = daily.rows.slice(7, 14).reduce((sum, row) => sum + asNumber(row.visitors), 0);
    const trend = previous7 ? ((last7 - previous7) / previous7) * 100 : 0;

    res.json({
      totalVisitors: asNumber(totals.rows[0].total_visitors),
      totalRevenue: asNumber(totals.rows[0].total_revenue),
      bestDay: {
        date: best.rows[0].date.slice(0, 10),
        visitors: asNumber(best.rows[0].visitors),
        revenue: asNumber(best.rows[0].revenue),
      },
      sevenDayTrend: Math.round(trend * 10) / 10,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/timeseries', async (_req, res, next) => {
  try {
    const result = await db.query(`
      SELECT metric_date::text AS date, visitors, revenue::numeric(12,2) AS revenue
      FROM daily_metrics
      ORDER BY metric_date ASC
    `);
    res.json(result.rows.map((row) => ({
      date: row.date.slice(0, 10),
      visitors: asNumber(row.visitors),
      revenue: asNumber(row.revenue),
    })));
  } catch (error) {
    next(error);
  }
});

app.get('/api/categories', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT label, value FROM categories ORDER BY value DESC');
    res.json(result.rows.map((row) => ({ label: row.label, value: asNumber(row.value) })));
  } catch (error) {
    next(error);
  }
});

app.get('/api/recent', async (_req, res, next) => {
  try {
    const result = await db.query(`
      SELECT name, category, value, created_at::text AS created_at
      FROM recent_items
      ORDER BY created_at DESC
      LIMIT 20
    `);
    res.json(result.rows.map((row) => ({
      name: row.name,
      category: row.category,
      value: asNumber(row.value),
      createdAt: row.created_at,
    })));
  } catch (error) {
    next(error);
  }
});

app.get('/api/settings', async (_req, res, next) => {
  try {
    const result = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    res.json({ theme: result.rows[0]?.value === 'dark' ? 'dark' : 'light' });
  } catch (error) {
    next(error);
  }
});

app.put('/api/settings', async (req, res, next) => {
  try {
    const theme = req.body?.theme;
    if (theme !== 'light' && theme !== 'dark') {
      res.status(400).json({ error: 'theme must be "light" or "dark"' });
      return;
    }
    await db.query(
      "INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [theme]
    );
    res.json({ theme });
  } catch (error) {
    next(error);
  }
});

const distDir = path.join(__dirname, '..', 'dist');
app.use(express.static(distDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distDir, 'index.html'), (error) => {
    if (error) next();
  });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Metrics API listening on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize database', error);
    process.exit(1);
  });
