import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const port = process.env.PORT || 3001;

const dbDir = path.join(root, 'pglite-data');
const db = new PGlite(dbDir);

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function createSeededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date DATE PRIMARY KEY,
      visitors INTEGER NOT NULL,
      revenue NUMERIC(12,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      label TEXT NOT NULL,
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
    await seedDb();
  }

  await db.query(
    `INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING`
  );
}

async function seedDb() {
  const rand = createSeededRandom(424242);
  const today = new Date('2025-02-28T12:00:00Z');

  await db.exec('BEGIN');
  try {
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(today.getUTCDate() - i);
      const dayIndex = 29 - i;
      const seasonal = Math.round(Math.sin(dayIndex / 4) * 140);
      const visitors = 2450 + dayIndex * 42 + seasonal + Math.floor(rand() * 280);
      const revenue = Number((visitors * (5.2 + rand() * 2.6) + 2200 + rand() * 3800).toFixed(2));
      await db.query('INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)', [
        isoDate(d),
        visitors,
        revenue,
      ]);
    }

    const categories = [
      ['Search & Discovery', 412380],
      ['Enterprise Infrastructure & Compliance', 1287650],
      ['Product Analytics', 684920],
      ['Customer Success', 223140],
      ['Partner Integrations', 356480],
      ['Self-Service Trials', 179760],
    ];
    for (const [label, value] of categories) {
      await db.query('INSERT INTO categories (label, value) VALUES ($1, $2)', [label, value]);
    }

    const itemCategories = categories.map(([label]) => label);
    const names = [
      'Northwind renewal', 'Acme workspace expansion', 'Globex onboarding', 'Initech usage review',
      'Umbrella compliance pack', 'Stark analytics upgrade', 'Wayne integration pilot', 'Hooli success plan',
      'Soylent enterprise audit', 'Vandelay pipeline sync', 'Wonka user migration', 'Cyberdyne data import',
      'Massive Dynamic dashboard', 'Tyrell retention review', 'Aperture lab rollout', 'Initrode report refresh',
      'Prestige worldwide setup', 'Monarch observability add-on', 'Oceanic platform check', 'Nakatomi service bundle'
    ];
    for (let i = 0; i < 20; i++) {
      const created = new Date(today);
      created.setUTCDate(today.getUTCDate() - i);
      created.setUTCHours(12 - (i % 5), 15 + i, 0, 0);
      const value = 18000 + Math.floor(rand() * 182000);
      await db.query(
        'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
        [names[i], itemCategories[i % itemCategories.length], value, created.toISOString()]
      );
    }

    await db.query(`INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING`);
    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
}

const app = express();
app.use(cors());
app.use(express.json());

function sendError(res, error) {
  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
}

app.get('/api/summary', async (_req, res) => {
  try {
    const totals = await db.query(`
      SELECT
        COALESCE(SUM(visitors), 0)::int AS total_visitors,
        COALESCE(SUM(revenue), 0)::float8 AS total_revenue
      FROM daily_metrics
    `);
    const best = await db.query(`
      SELECT date::text AS date, visitors, revenue::float8 AS revenue
      FROM daily_metrics
      ORDER BY visitors DESC, revenue DESC
      LIMIT 1
    `);
    const trend = await db.query(`
      WITH ordered AS (
        SELECT date, visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM daily_metrics
      ), sums AS (
        SELECT
          SUM(CASE WHEN rn BETWEEN 1 AND 7 THEN visitors ELSE 0 END)::float8 AS recent,
          SUM(CASE WHEN rn BETWEEN 8 AND 14 THEN visitors ELSE 0 END)::float8 AS previous
        FROM ordered
      )
      SELECT CASE WHEN previous = 0 THEN 0 ELSE ((recent - previous) / previous) * 100 END::float8 AS trend FROM sums
    `);
    const categoryMax = await db.query('SELECT MAX(value)::int AS largest_category_value FROM categories');
    res.json({
      totalVisitors: totals.rows[0].total_visitors,
      totalRevenue: Number(totals.rows[0].total_revenue.toFixed(2)),
      bestDay: best.rows[0],
      sevenDayTrend: Number(trend.rows[0].trend.toFixed(2)),
      largestCategoryValue: categoryMax.rows[0].largest_category_value,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/timeseries', async (_req, res) => {
  try {
    const result = await db.query(
      'SELECT date::text AS date, visitors, revenue::float8 AS revenue FROM daily_metrics ORDER BY date ASC'
    );
    res.json(result.rows);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/categories', async (_req, res) => {
  try {
    const result = await db.query('SELECT id, label, value FROM categories ORDER BY value DESC');
    res.json(result.rows);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/recent', async (_req, res) => {
  try {
    const result = await db.query(
      'SELECT id, name, category, value, created_at::text AS created_at FROM recent_items ORDER BY created_at DESC LIMIT 20'
    );
    res.json(result.rows);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/settings', async (_req, res) => {
  try {
    const result = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    res.json({ theme: result.rows[0]?.value === 'dark' ? 'dark' : 'light' });
  } catch (error) {
    sendError(res, error);
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const theme = req.body?.theme;
    if (theme !== 'light' && theme !== 'dark') {
      return res.status(400).json({ error: 'theme must be light or dark' });
    }
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('theme', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [theme]
    );
    res.json({ theme });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

await initDb();
app.listen(port, () => {
  console.log(`Metrics API listening on http://localhost:${port}`);
});
