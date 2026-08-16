import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;

const dbDir = path.join(__dirname, 'pglite-data');
const db = new PGlite(dbDir);

function isoDay(day) {
  return `2025-01-${String(day).padStart(2, '0')}`;
}

async function initDb() {
  await db.query(`CREATE TABLE IF NOT EXISTS daily_metrics (
    day date PRIMARY KEY,
    visitors integer NOT NULL,
    revenue numeric(12,2) NOT NULL
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS categories (
    id serial PRIMARY KEY,
    label text NOT NULL,
    value integer NOT NULL
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS recent_items (
    id serial PRIMARY KEY,
    name text NOT NULL,
    category text NOT NULL,
    value integer NOT NULL,
    created_at timestamptz NOT NULL
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS settings (
    key text PRIMARY KEY,
    value text NOT NULL
  )`);

  const count = await db.query('SELECT COUNT(*)::int AS count FROM daily_metrics');
  if (Number(count.rows[0]?.count || 0) > 0) {
    await db.query(`INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING`);
    return;
  }

  await db.query('BEGIN');
  try {
    for (let day = 1; day <= 30; day += 1) {
      // Fixed pseudo-seasonal data: deterministic, varied, and totals over seven digits.
      const visitors = 1250 + day * 43 + ((day * 97) % 410) + (day % 6 === 0 ? 260 : 0);
      const revenue = Number((24500 + day * 1280 + ((day * day * 37) % 9200) + (day % 7 === 0 ? 7200 : 0)).toFixed(2));
      await db.query('INSERT INTO daily_metrics (day, visitors, revenue) VALUES ($1, $2, $3)', [isoDay(day), visitors, revenue]);
    }

    const categories = [
      ['Enterprise Infrastructure & Compliance', 1284760],
      ['Self-Service Analytics', 845230],
      ['Customer Success', 612450],
      ['Product Adoption', 473900],
      ['Marketing Operations', 356780],
      ['Partner Enablement', 214640]
    ];
    for (const [label, value] of categories) {
      await db.query('INSERT INTO categories (label, value) VALUES ($1, $2)', [label, value]);
    }

    const itemNames = [
      'Northwind rollout', 'Quarterly pipeline audit', 'Compliance review', 'Mobile adoption cohort',
      'Executive scorecard', 'Renewal health scan', 'Partner portal refresh', 'Trial conversion sprint',
      'Usage anomaly review', 'Forecast workbook', 'Data quality sweep', 'Retention experiment',
      'Onboarding checklist', 'Billing migration', 'Regional campaign', 'Capacity model',
      'Insights export', 'Support backlog trim', 'Feature launch pulse', 'Revenue reconciliation'
    ];
    for (let i = 0; i < itemNames.length; i += 1) {
      const category = categories[i % categories.length][0];
      const value = 9800 + ((i + 3) * 7919) % 88700;
      const createdAt = `2025-01-${String(30 - i).padStart(2, '0')}T${String(9 + (i % 9)).padStart(2, '0')}:15:00Z`;
      await db.query('INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)', [itemNames[i], category, value, createdAt]);
    }

    await db.query(`INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING`);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/summary', async (_req, res, next) => {
  try {
    const totals = await db.query(`SELECT
      COALESCE(SUM(visitors), 0)::int AS total_visitors,
      COALESCE(SUM(revenue), 0)::float8 AS total_revenue
      FROM daily_metrics`);
    const best = await db.query(`SELECT day::text AS day, visitors::int, revenue::float8
      FROM daily_metrics ORDER BY revenue DESC, visitors DESC LIMIT 1`);
    const latest = await db.query(`SELECT visitors::int FROM daily_metrics ORDER BY day DESC LIMIT 14`);
    const rows = latest.rows.map((r) => Number(r.visitors));
    const last7 = rows.slice(0, 7).reduce((a, b) => a + b, 0);
    const prev7 = rows.slice(7, 14).reduce((a, b) => a + b, 0);
    const trend = prev7 ? ((last7 - prev7) / prev7) * 100 : 0;
    res.json({
      totalVisitors: Number(totals.rows[0].total_visitors),
      totalRevenue: Number(totals.rows[0].total_revenue),
      bestDay: best.rows[0] || null,
      sevenDayTrendPercent: Number(trend.toFixed(1))
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/timeseries', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT day::text AS date, visitors::int, revenue::float8 FROM daily_metrics ORDER BY day ASC');
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

app.get('/api/categories', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT id::int, label, value::int FROM categories ORDER BY value DESC');
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

app.get('/api/recent', async (_req, res, next) => {
  try {
    const result = await db.query(`SELECT id::int, name, category, value::int, created_at::text
      FROM recent_items ORDER BY created_at DESC LIMIT 20`);
    res.json(result.rows);
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
      res.status(400).json({ error: 'theme must be light or dark' });
      return;
    }
    await db.query(`INSERT INTO settings (key, value) VALUES ('theme', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [theme]);
    res.json({ theme });
  } catch (error) {
    next(error);
  }
});

const distDir = path.join(__dirname, 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
} else {
  // During `npm run dev`, Vite serves the client on 5173. Redirect non-API
  // browser requests from the API port so either advertised URL opens the app.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.redirect(302, 'http://localhost:5173' + req.originalUrl);
  });
}

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`Metrics API listening on http://localhost:${PORT}`));
}).catch((error) => {
  console.error('Failed to initialize database', error);
  process.exit(1);
});
