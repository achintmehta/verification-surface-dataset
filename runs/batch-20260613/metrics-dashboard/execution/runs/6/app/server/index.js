import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(path.join(process.cwd(), 'pglite-data'));

const dailyRows = [
  ['2025-01-01', 3920, 33120], ['2025-01-02', 4185, 35850], ['2025-01-03', 4410, 37240],
  ['2025-01-04', 4275, 34950], ['2025-01-05', 4630, 38400], ['2025-01-06', 4890, 41225],
  ['2025-01-07', 5210, 43890], ['2025-01-08', 5065, 42110], ['2025-01-09', 5385, 45970],
  ['2025-01-10', 5620, 48610], ['2025-01-11', 5480, 47250], ['2025-01-12', 5775, 50115],
  ['2025-01-13', 6010, 52680], ['2025-01-14', 5925, 51140], ['2025-01-15', 6280, 54850],
  ['2025-01-16', 6515, 57120], ['2025-01-17', 6390, 55610], ['2025-01-18', 6745, 58970],
  ['2025-01-19', 6990, 61480], ['2025-01-20', 6825, 59650], ['2025-01-21', 7150, 62940],
  ['2025-01-22', 7420, 65710], ['2025-01-23', 7315, 64120], ['2025-01-24', 7680, 68290],
  ['2025-01-25', 7895, 70550], ['2025-01-26', 7720, 68910], ['2025-01-27', 8065, 72460],
  ['2025-01-28', 8340, 75880], ['2025-01-29', 8195, 73950], ['2025-01-30', 8610, 78920]
];

const categoryRows = [
  ['Search Marketing', 842000],
  ['Organic Growth', 618500],
  ['Enterprise Infrastructure & Compliance', 1250000],
  ['Partner Sales', 487300],
  ['Product Analytics', 366900],
  ['Customer Success', 275400]
];

const itemNames = [
  'Quarterly pipeline review', 'Attribution model refresh', 'Executive KPI export', 'Trial conversion audit',
  'Partner co-sell packet', 'Security evidence upload', 'Funnel anomaly triage', 'Regional forecast update',
  'Audience cohort rebuild', 'Enterprise renewal note', 'Lifecycle campaign launch', 'Board metrics snapshot',
  'Dashboard QA sweep', 'Gross margin check', 'Customer health import', 'Paid search sync',
  'Usage threshold alert', 'Compliance intake form', 'Revenue recognition pass', 'Sales capacity memo'
];

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      day date PRIMARY KEY,
      visitors integer NOT NULL,
      revenue integer NOT NULL
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
  if (Number(count.rows[0].count) === 0) {
    await db.query('BEGIN');
    try {
      for (const [day, visitors, revenue] of dailyRows) {
        await db.query('INSERT INTO daily_metrics (day, visitors, revenue) VALUES ($1, $2, $3)', [day, visitors, revenue]);
      }
      for (const [label, value] of categoryRows) {
        await db.query('INSERT INTO categories (label, value) VALUES ($1, $2)', [label, value]);
      }
      for (let i = 0; i < 20; i++) {
        const cat = categoryRows[i % categoryRows.length][0];
        const value = 15250 + ((i * 9321) % 156000);
        const day = String(30 - i).padStart(2, '0');
        await db.query(
          'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
          [itemNames[i], cat, value, `2025-01-${day}T${String(9 + (i % 9)).padStart(2, '0')}:30:00Z`]
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

function oneRow(result) {
  return result.rows[0] || {};
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/summary', async (_req, res, next) => {
  try {
    const totals = oneRow(await db.query('SELECT SUM(visitors)::int AS total_visitors, SUM(revenue)::int AS total_revenue FROM daily_metrics'));
    const best = oneRow(await db.query("SELECT to_char(day, 'YYYY-MM-DD') AS day, visitors, revenue FROM daily_metrics ORDER BY revenue DESC LIMIT 1"));
    const trend = oneRow(await db.query(`
      WITH ordered AS (
        SELECT day, visitors, ROW_NUMBER() OVER (ORDER BY day DESC) AS rn FROM daily_metrics
      ), sums AS (
        SELECT
          SUM(CASE WHEN rn BETWEEN 1 AND 7 THEN visitors ELSE 0 END)::numeric AS recent,
          SUM(CASE WHEN rn BETWEEN 8 AND 14 THEN visitors ELSE 0 END)::numeric AS previous
        FROM ordered
      )
      SELECT ROUND(((recent - previous) / NULLIF(previous, 0) * 100), 1)::float AS trend_percent FROM sums
    `));
    res.json({
      totalVisitors: Number(totals.total_visitors),
      totalRevenue: Number(totals.total_revenue),
      bestDay: { day: best.day, visitors: Number(best.visitors), revenue: Number(best.revenue) },
      sevenDayTrendPercent: Number(trend.trend_percent)
    });
  } catch (err) { next(err); }
});

app.get('/api/timeseries', async (_req, res, next) => {
  try {
    const result = await db.query("SELECT to_char(day, 'YYYY-MM-DD') AS date, visitors, revenue FROM daily_metrics ORDER BY day");
    res.json(result.rows.map(r => ({ date: r.date, visitors: Number(r.visitors), revenue: Number(r.revenue) })));
  } catch (err) { next(err); }
});

app.get('/api/categories', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT label, value FROM categories ORDER BY value DESC');
    res.json(result.rows.map(r => ({ label: r.label, value: Number(r.value) })));
  } catch (err) { next(err); }
});

app.get('/api/recent', async (_req, res, next) => {
  try {
    const result = await db.query("SELECT name, category, value, to_char(created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_at FROM recent_items ORDER BY created_at DESC LIMIT 20");
    res.json(result.rows.map(r => ({ name: r.name, category: r.category, value: Number(r.value), createdAt: r.created_at })));
  } catch (err) { next(err); }
});

app.get('/api/settings', async (_req, res, next) => {
  try {
    const result = await db.query("SELECT value AS theme FROM settings WHERE key = 'theme'");
    res.json({ theme: result.rows[0]?.theme === 'dark' ? 'dark' : 'light' });
  } catch (err) { next(err); }
});

app.put('/api/settings', async (req, res, next) => {
  try {
    const theme = req.body?.theme;
    if (!['light', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    await db.query("INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [theme]);
    res.json({ theme });
  } catch (err) { next(err); }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const dist = path.join(process.cwd(), 'dist');
app.use(express.static(dist));
app.get(/.*/, (_req, res, next) => {
  res.sendFile(path.join(dist, 'index.html'), (err) => err && next());
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`Metrics API listening on http://localhost:${PORT}`));
}).catch((error) => {
  console.error('Failed to initialize database', error);
  process.exit(1);
});
