import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const db = new PGlite(path.join(__dirname, 'pglite-data'));

function isoDateOffset(daysAgo) {
  const d = new Date(Date.UTC(2025, 0, 30));
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function seededSeries() {
  const rows = [];
  for (let i = 29; i >= 0; i--) {
    const index = 29 - i;
    const visitors = 1820 + index * 57 + ((index * 37) % 280) + (index % 6 === 0 ? 260 : 0);
    const revenue = Number((24500 + index * 893 + ((index * 719) % 4200) + (index % 8 === 3 ? 5200 : 0)).toFixed(2));
    rows.push({ date: isoDateOffset(i), visitors, revenue });
  }
  return rows;
}

const categorySeed = [
  ['Enterprise Infrastructure & Compliance', 1250000],
  ['Product Analytics', 742300],
  ['Customer Success', 516900],
  ['Marketing Campaigns', 389450],
  ['Operations', 274100],
  ['Research Labs', 158750]
];

const itemNames = [
  'Quarterly cloud migration report', 'Renewal cohort analysis', 'Executive KPI export', 'Pipeline attribution model',
  'Compliance readiness review', 'Customer sentiment sample', 'Usage anomaly investigation', 'Regional revenue snapshot',
  'Ad performance reconciliation', 'Forecast adjustment memo', 'Retention risk shortlist', 'Partner scorecard refresh',
  'Infrastructure cost audit', 'Enterprise onboarding plan', 'Product launch dashboard', 'Security metrics packet',
  'Trial conversion digest', 'Support volume briefing', 'Capacity planning worksheet', 'Board metrics appendix'
];

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date DATE PRIMARY KEY,
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

  const count = await db.query('SELECT COUNT(*)::int AS count FROM daily_metrics');
  if (Number(count.rows[0].count) === 0) {
    await db.exec('BEGIN');
    try {
      for (const row of seededSeries()) {
        await db.query('INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)', [row.date, row.visitors, row.revenue]);
      }
      for (const [label, value] of categorySeed) {
        await db.query('INSERT INTO categories (label, value) VALUES ($1, $2)', [label, value]);
      }
      for (let i = 0; i < itemNames.length; i++) {
        const cat = categorySeed[i % categorySeed.length][0];
        const value = 12400 + ((i * 7919) % 185000);
        const createdAt = new Date(Date.UTC(2025, 0, 30, 14, 0, 0));
        createdAt.setUTCDate(createdAt.getUTCDate() - i);
        createdAt.setUTCHours(14 - (i % 10));
        await db.query(
          'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
          [itemNames[i], cat, value, createdAt.toISOString()]
        );
      }
      await db.query("INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING");
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  } else {
    await db.query("INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING");
  }
}

function dollars(value) {
  return Number(value || 0);
}

app.get('/api/summary', async (_req, res, next) => {
  try {
    const totals = await db.query(`
      SELECT
        COALESCE(SUM(visitors), 0)::int AS total_visitors,
        COALESCE(SUM(revenue), 0)::float8 AS total_revenue
      FROM daily_metrics
    `);
    const best = await db.query(`
      SELECT date::text, visitors, revenue::float8 AS revenue
      FROM daily_metrics
      ORDER BY revenue DESC, visitors DESC
      LIMIT 1
    `);
    const trend = await db.query(`
      WITH ordered AS (
        SELECT date, visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM daily_metrics
      ), buckets AS (
        SELECT
          SUM(visitors) FILTER (WHERE rn BETWEEN 1 AND 7)::float8 AS last7,
          SUM(visitors) FILTER (WHERE rn BETWEEN 8 AND 14)::float8 AS prev7
        FROM ordered
      )
      SELECT CASE WHEN prev7 IS NULL OR prev7 = 0 THEN 0 ELSE ((last7 - prev7) / prev7) * 100 END AS trend FROM buckets
    `);
    const totalVisitors = Number(totals.rows[0].total_visitors);
    const totalRevenue = dollars(totals.rows[0].total_revenue);
    res.json({
      totalVisitors,
      totalRevenue,
      bestDay: best.rows[0] ? {
        date: best.rows[0].date.slice(0, 10),
        visitors: Number(best.rows[0].visitors),
        revenue: dollars(best.rows[0].revenue)
      } : null,
      sevenDayTrend: Number(trend.rows[0]?.trend || 0)
    });
  } catch (error) { next(error); }
});

app.get('/api/timeseries', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT date::text, visitors, revenue::float8 AS revenue FROM daily_metrics ORDER BY date ASC');
    res.json(result.rows.map(r => ({ date: r.date.slice(0, 10), visitors: Number(r.visitors), revenue: dollars(r.revenue) })));
  } catch (error) { next(error); }
});

app.get('/api/categories', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT label, value FROM categories ORDER BY value DESC');
    res.json(result.rows.map(r => ({ label: r.label, value: Number(r.value) })));
  } catch (error) { next(error); }
});

app.get('/api/recent', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20');
    res.json(result.rows.map(r => ({
      name: r.name,
      category: r.category,
      value: Number(r.value),
      createdAt: new Date(r.created_at).toISOString()
    })));
  } catch (error) { next(error); }
});

app.get('/api/settings', async (_req, res, next) => {
  try {
    const result = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    res.json({ theme: result.rows[0]?.value === 'dark' ? 'dark' : 'light' });
  } catch (error) { next(error); }
});

app.put('/api/settings', async (req, res, next) => {
  try {
    const theme = req.body?.theme;
    if (theme !== 'light' && theme !== 'dark') {
      return res.status(400).json({ error: 'theme must be light or dark' });
    }
    await db.query("INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [theme]);
    res.json({ theme });
  } catch (error) { next(error); }
});

app.get('/', async (_req, res, next) => {
  try {
    const settings = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    const theme = settings.rows[0]?.value === 'dark' ? 'dark' : 'light';
    const html = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
    res.type('html').send(html.replaceAll('%THEME%', theme));
  } catch (error) { next(error); }
});

app.use(express.static(__dirname, { extensions: ['html'], index: false }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Metrics dashboard server listening on http://localhost:${PORT}`);
  });
}).catch(error => {
  console.error('Failed to initialize database', error);
  process.exit(1);
});
