import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'pglite-data');
const port = Number(process.env.PORT || 3000);

const db = new PGlite(dataDir);

function currency(value) {
  return Math.round(value * 100) / 100;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

async function exec(sql, params) {
  return db.query(sql, params);
}

async function initializeDatabase() {
  await exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date date PRIMARY KEY,
      visitors integer NOT NULL,
      revenue numeric(12,2) NOT NULL
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

  const count = await exec('SELECT COUNT(*)::int AS count FROM daily_metrics');
  if (Number(count.rows[0].count) > 0) {
    await exec("INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING");
    return;
  }

  const rand = seededRandom(20240615);
  const base = new Date(Date.UTC(2025, 0, 1));
  for (let i = 0; i < 30; i += 1) {
    const day = new Date(base);
    day.setUTCDate(base.getUTCDate() + i);
    const weekdayLift = [0.94, 1.03, 1.07, 1.1, 1.16, 0.86, 0.78][day.getUTCDay()];
    const trend = 1 + i * 0.018;
    const visitors = Math.round((1650 + rand() * 720) * weekdayLift * trend);
    const revenue = currency(visitors * (5.25 + rand() * 2.35));
    await exec('INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)', [day.toISOString().slice(0, 10), visitors, revenue]);
  }

  const categories = [
    [1, 'Acquisition', 438250],
    [2, 'Activation', 267900],
    [3, 'Retention', 592340],
    [4, 'Enterprise Infrastructure & Compliance', 1248750],
    [5, 'Self-Service', 181450],
    [6, 'Partner Channels', 334720]
  ];
  for (const row of categories) {
    await exec('INSERT INTO categories (id, label, value) VALUES ($1, $2, $3)', row);
  }

  const itemNames = [
    'Northstar rollout', 'Quarterly plan', 'Pipeline audit', 'Usage review', 'Revenue sync',
    'Compliance packet', 'Partner launch', 'Lifecycle test', 'Enterprise briefing', 'Dashboard export',
    'Segment refresh', 'Forecast update', 'Campaign QA', 'Pricing analysis', 'Retention sprint',
    'Self-serve cohort', 'Infrastructure review', 'Support handoff', 'Attribution model', 'Executive packet'
  ];
  for (let i = 0; i < 20; i += 1) {
    const category = categories[i % categories.length][1];
    const created = new Date(Date.UTC(2025, 0, 30, 15, 0, 0));
    created.setUTCDate(created.getUTCDate() - i);
    const value = Math.round(8500 + rand() * 88000 + (i % 5) * 12000);
    await exec(
      'INSERT INTO recent_items (id, name, category, value, created_at) VALUES ($1, $2, $3, $4, $5)',
      [i + 1, itemNames[i], category, value, created.toISOString()]
    );
  }

  await exec("INSERT INTO settings (key, value) VALUES ('theme', 'light')");
}

function toNumber(row, key) {
  return Number(row[key]);
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/summary', async (_req, res, next) => {
  try {
    const totals = await exec('SELECT COALESCE(SUM(visitors),0)::int AS visitors, COALESCE(SUM(revenue),0)::numeric AS revenue FROM daily_metrics');
    const best = await exec('SELECT date::text, visitors, revenue FROM daily_metrics ORDER BY revenue DESC, visitors DESC LIMIT 1');
    const trendRows = await exec(`
      SELECT
        COALESCE(SUM(visitors) FILTER (WHERE date >= (SELECT MAX(date) - INTERVAL '6 days' FROM daily_metrics)), 0)::numeric AS recent,
        COALESCE(SUM(visitors) FILTER (WHERE date < (SELECT MAX(date) - INTERVAL '6 days' FROM daily_metrics) AND date >= (SELECT MAX(date) - INTERVAL '13 days' FROM daily_metrics)), 0)::numeric AS previous
      FROM daily_metrics
    `);
    const recent = toNumber(trendRows.rows[0], 'recent');
    const previous = toNumber(trendRows.rows[0], 'previous');
    const trendPercent = previous === 0 ? 0 : ((recent - previous) / previous) * 100;
    res.json({
      totalVisitors: toNumber(totals.rows[0], 'visitors'),
      totalRevenue: toNumber(totals.rows[0], 'revenue'),
      bestDay: best.rows[0] ? {
        date: best.rows[0].date.slice(0, 10),
        visitors: Number(best.rows[0].visitors),
        revenue: Number(best.rows[0].revenue)
      } : null,
      sevenDayTrendPercent: Math.round(trendPercent * 10) / 10
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/timeseries', async (_req, res, next) => {
  try {
    const result = await exec('SELECT date::text, visitors, revenue FROM daily_metrics ORDER BY date ASC');
    res.json(result.rows.map((row) => ({ date: row.date.slice(0, 10), visitors: Number(row.visitors), revenue: Number(row.revenue) })));
  } catch (error) {
    next(error);
  }
});

app.get('/api/categories', async (_req, res, next) => {
  try {
    const result = await exec('SELECT id, label, value FROM categories ORDER BY value DESC');
    res.json(result.rows.map((row) => ({ id: Number(row.id), label: row.label, value: Number(row.value) })));
  } catch (error) {
    next(error);
  }
});

app.get('/api/recent', async (_req, res, next) => {
  try {
    const result = await exec('SELECT id, name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20');
    res.json(result.rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      category: row.category,
      value: Number(row.value),
      createdAt: new Date(row.created_at).toISOString()
    })));
  } catch (error) {
    next(error);
  }
});

app.get('/api/settings', async (_req, res, next) => {
  try {
    const result = await exec("SELECT value FROM settings WHERE key = 'theme'");
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
    await exec("INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [theme]);
    res.json({ theme });
  } catch (error) {
    next(error);
  }
});

const distDir = path.join(rootDir, 'dist');
app.use(express.static(distDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distDir, 'index.html'), (error) => {
    if (error) res.status(404).send('Build the frontend with npm run build, or run npm run dev.');
  });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
});

await initializeDatabase();
app.listen(port, () => {
  console.log(`metrics-dashboard API listening on http://localhost:${port}`);
});
