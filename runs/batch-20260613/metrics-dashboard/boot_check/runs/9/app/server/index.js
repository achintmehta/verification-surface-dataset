import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(path.join(rootDir, 'pglite-data'));

function money(n) {
  return Math.round(n * 100) / 100;
}

function buildSeed() {
  const start = new Date('2025-01-01T00:00:00Z');
  const daily = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const visitors = 18500 + i * 1320 + ((i * 37) % 9) * 410 + (i % 6 === 0 ? 2800 : 0);
    const revenue = money(42000 + visitors * 2.18 + ((i * 7919) % 12000) + (i % 5 === 2 ? 15500 : 0));
    daily.push({ date: d.toISOString().slice(0, 10), visitors, revenue });
  }

  const categories = [
    ['Search & Discovery', 928450],
    ['Enterprise Infrastructure & Compliance', 1432765],
    ['Self-Service Analytics', 784120],
    ['Partner Integrations', 612340],
    ['Mobile Experience', 531980],
    ['Support Operations', 354760]
  ];

  const itemNames = [
    'Northwind renewal', 'Acme expansion', 'Globex onboarding', 'Initech audit', 'Umbrella migration',
    'Hooli workspace', 'Stark dashboard', 'Wayne compliance', 'Wonka mobile pilot', 'Soylent integration',
    'Massive Dynamic sync', 'Tyrell search tune', 'Cyberdyne analytics', 'Oscorp support pack', 'Vehement rollout',
    'Pied Piper dataset', 'Aperture review', 'Black Mesa export', 'Vandelay import', 'Monarch enablement'
  ];
  const recent = itemNames.map((name, i) => {
    const d = new Date('2025-01-30T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - i);
    const category = categories[i % categories.length][0];
    const value = 48000 + ((i * 17389) % 150000) + (i === 3 ? 1000000 : 0);
    return { name, category, value, created_at: d.toISOString() };
  });
  return { daily, categories, recent };
}

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date date PRIMARY KEY,
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
      id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      theme text NOT NULL CHECK (theme IN ('light','dark'))
    );
  `);

  const seeded = await db.query('SELECT COUNT(*)::int AS count FROM daily_metrics');
  if ((seeded.rows[0]?.count ?? 0) === 0) {
    const { daily, categories, recent } = buildSeed();
    await db.query('BEGIN');
    try {
      for (const row of daily) {
        await db.query('INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)', [row.date, row.visitors, row.revenue]);
      }
      for (const [label, value] of categories) {
        await db.query('INSERT INTO categories (label, value) VALUES ($1, $2)', [label, value]);
      }
      for (const row of recent) {
        await db.query('INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)', [row.name, row.category, row.value, row.created_at]);
      }
      await db.query("INSERT INTO settings (id, theme) VALUES (1, 'light') ON CONFLICT (id) DO NOTHING");
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
  } else {
    await db.query("INSERT INTO settings (id, theme) VALUES (1, 'light') ON CONFLICT (id) DO NOTHING");
  }
}

app.get('/api/summary', async (_req, res, next) => {
  try {
    const result = await db.query(`
      WITH ordered AS (
        SELECT date, visitors, revenue, row_number() OVER (ORDER BY date DESC) AS rn
        FROM daily_metrics
      ), sums AS (
        SELECT
          SUM(visitors)::int AS total_visitors,
          SUM(revenue)::numeric(14,2) AS total_revenue,
          SUM(CASE WHEN rn BETWEEN 1 AND 7 THEN visitors ELSE 0 END)::numeric AS last_7,
          SUM(CASE WHEN rn BETWEEN 8 AND 14 THEN visitors ELSE 0 END)::numeric AS prev_7
        FROM ordered
      ), best AS (
        SELECT date, visitors, revenue FROM daily_metrics ORDER BY visitors DESC, revenue DESC LIMIT 1
      )
      SELECT total_visitors, total_revenue, last_7, prev_7,
             best.date AS best_day, best.visitors AS best_day_visitors, best.revenue AS best_day_revenue
      FROM sums CROSS JOIN best;
    `);
    const row = result.rows[0];
    const prev = Number(row.prev_7 || 0);
    const trend = prev === 0 ? 0 : ((Number(row.last_7) - prev) / prev) * 100;
    res.json({
      totalVisitors: Number(row.total_visitors),
      totalRevenue: Number(row.total_revenue),
      bestDay: { date: row.best_day, visitors: Number(row.best_day_visitors), revenue: Number(row.best_day_revenue) },
      sevenDayTrendPct: Number(trend.toFixed(1))
    });
  } catch (err) { next(err); }
});

app.get('/api/timeseries', async (_req, res, next) => {
  try {
    const { rows } = await db.query('SELECT date, visitors, revenue FROM daily_metrics ORDER BY date');
    res.json(rows.map((r) => ({ date: r.date, visitors: Number(r.visitors), revenue: Number(r.revenue) })));
  } catch (err) { next(err); }
});

app.get('/api/categories', async (_req, res, next) => {
  try {
    const { rows } = await db.query('SELECT label, value FROM categories ORDER BY value DESC');
    res.json(rows.map((r) => ({ label: r.label, value: Number(r.value) })));
  } catch (err) { next(err); }
});

app.get('/api/recent', async (_req, res, next) => {
  try {
    const { rows } = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20');
    res.json(rows.map((r) => ({ name: r.name, category: r.category, value: Number(r.value), createdAt: r.created_at })));
  } catch (err) { next(err); }
});

app.get('/api/settings', async (_req, res, next) => {
  try {
    const { rows } = await db.query("SELECT theme FROM settings WHERE id = 1");
    res.json({ theme: rows[0]?.theme === 'dark' ? 'dark' : 'light' });
  } catch (err) { next(err); }
});

app.put('/api/settings', async (req, res, next) => {
  try {
    const theme = req.body?.theme;
    if (!['light', 'dark'].includes(theme)) {
      res.status(400).json({ error: 'theme must be light or dark' });
      return;
    }
    await db.query('INSERT INTO settings (id, theme) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET theme = EXCLUDED.theme', [theme]);
    res.json({ theme });
  } catch (err) { next(err); }
});

// Serve the Vite source app directly when only the backend is running; Vite remains available for dev.
app.use(express.static(rootDir));
app.use((req, res, next) => {
  if (req.method === 'GET' && req.accepts('html')) {
    res.sendFile(path.join(rootDir, 'index.html'));
  } else {
    next();
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`metrics-dashboard listening on http://localhost:${PORT}`));
}).catch((err) => {
  console.error('Failed to initialize database', err);
  process.exit(1);
});
