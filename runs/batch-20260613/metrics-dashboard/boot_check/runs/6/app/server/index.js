import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(path.join(rootDir, 'pglite-data'));

function isoDate(offset) {
  const d = new Date(Date.UTC(2024, 4, 1 + offset));
  return d.toISOString().slice(0, 10);
}

function createdAt(offset) {
  const d = new Date(Date.UTC(2024, 4, 30 - offset, 10 + (offset % 10), (offset * 7) % 60));
  return d.toISOString();
}

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      day date PRIMARY KEY,
      visitors integer NOT NULL,
      revenue numeric(12, 2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id integer PRIMARY KEY,
      label text NOT NULL,
      value integer NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_items (
      id integer PRIMARY KEY,
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

  await db.query("INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING");

  const seeded = await db.query('SELECT COUNT(*)::int AS count FROM daily_metrics');
  if (Number(seeded.rows[0].count) > 0) return;

  const daily = [];
  for (let i = 0; i < 30; i += 1) {
    const wave = Math.round(Math.sin(i / 3) * 210);
    const weekendDip = (i % 7 === 5 || i % 7 === 6) ? -140 : 0;
    const visitors = 1180 + i * 34 + wave + weekendDip + ((i * 97) % 83);
    const revenue = Number((visitors * (6.25 + ((i % 6) * 0.42)) + 520 + ((i * 137) % 900)).toFixed(2));
    daily.push([isoDate(i), visitors, revenue]);
  }

  const categories = [
    [1, 'Product Analytics', 458200],
    [2, 'Enterprise Infrastructure & Compliance', 1234567],
    [3, 'Customer Success', 339850],
    [4, 'Marketing Operations', 275430],
    [5, 'Developer Tooling', 198760],
    [6, 'Finance Automation', 414990]
  ];

  const recentCats = categories.map((c) => c[1]);
  const recent = Array.from({ length: 20 }, (_, i) => [
    i + 1,
    `Metric packet ${String(i + 1).padStart(2, '0')}`,
    recentCats[(i * 3 + 1) % recentCats.length],
    48200 + ((i * 7919) % 185000),
    createdAt(i)
  ]);

  await db.query('BEGIN');
  try {
    for (const row of daily) {
      await db.query('INSERT INTO daily_metrics (day, visitors, revenue) VALUES ($1, $2, $3)', row);
    }
    for (const row of categories) {
      await db.query('INSERT INTO categories (id, label, value) VALUES ($1, $2, $3)', row);
    }
    for (const row of recent) {
      await db.query('INSERT INTO recent_items (id, name, category, value, created_at) VALUES ($1, $2, $3, $4, $5)', row);
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

app.get('/api/summary', asyncHandler(async (_req, res) => {
  const totals = await db.query(`
    SELECT
      SUM(visitors)::int AS total_visitors,
      ROUND(SUM(revenue), 2)::text AS total_revenue
    FROM daily_metrics
  `);
  const best = await db.query(`
    SELECT day::text, visitors, revenue::text
    FROM daily_metrics
    ORDER BY visitors DESC, day ASC
    LIMIT 1
  `);
  const trend = await db.query(`
    WITH numbered AS (
      SELECT visitors, ROW_NUMBER() OVER (ORDER BY day DESC) AS rn
      FROM daily_metrics
    ), sums AS (
      SELECT
        SUM(visitors) FILTER (WHERE rn BETWEEN 1 AND 7) AS last_7,
        SUM(visitors) FILTER (WHERE rn BETWEEN 8 AND 14) AS prev_7
      FROM numbered
    )
    SELECT ROUND(((last_7 - prev_7)::numeric / NULLIF(prev_7, 0)) * 100, 1)::text AS trend_pct
    FROM sums
  `);

  res.json({
    totalVisitors: Number(totals.rows[0].total_visitors),
    totalRevenue: Number(totals.rows[0].total_revenue),
    bestDay: {
      date: best.rows[0].day,
      visitors: Number(best.rows[0].visitors),
      revenue: Number(best.rows[0].revenue)
    },
    sevenDayTrendPct: Number(trend.rows[0].trend_pct)
  });
}));

app.get('/api/timeseries', asyncHandler(async (_req, res) => {
  const result = await db.query('SELECT day::text AS date, visitors, revenue::text FROM daily_metrics ORDER BY day ASC');
  res.json(result.rows.map((row) => ({ date: row.date, visitors: Number(row.visitors), revenue: Number(row.revenue) })));
}));

app.get('/api/categories', asyncHandler(async (_req, res) => {
  const result = await db.query('SELECT id, label, value FROM categories ORDER BY value DESC');
  res.json(result.rows.map((row) => ({ id: Number(row.id), label: row.label, value: Number(row.value) })));
}));

app.get('/api/recent', asyncHandler(async (_req, res) => {
  const result = await db.query('SELECT id, name, category, value, created_at::text AS created_at FROM recent_items ORDER BY created_at DESC, id ASC LIMIT 20');
  res.json(result.rows.map((row) => ({ id: Number(row.id), name: row.name, category: row.category, value: Number(row.value), createdAt: row.created_at })));
}));

app.get('/api/settings', asyncHandler(async (_req, res) => {
  const result = await db.query("SELECT value FROM settings WHERE key = 'theme'");
  res.json({ theme: result.rows[0]?.value === 'dark' ? 'dark' : 'light' });
}));

app.put('/api/settings', asyncHandler(async (req, res) => {
  const theme = req.body?.theme;
  if (theme !== 'light' && theme !== 'dark') {
    res.status(400).json({ error: 'theme must be "light" or "dark"' });
    return;
  }
  await db.query("INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [theme]);
  res.json({ theme });
}));

app.use(express.static(rootDir));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(rootDir, 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Metrics dashboard listening on http://localhost:${PORT}`);
  });
}).catch((error) => {
  console.error('Failed to initialize database', error);
  process.exit(1);
});
