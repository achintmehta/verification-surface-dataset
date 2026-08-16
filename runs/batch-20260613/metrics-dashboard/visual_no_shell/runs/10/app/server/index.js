import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 4000;
const rootDir = path.join(__dirname, '..');
const db = new PGlite(path.join(rootDir, 'pgdata'));

function isoDate(daysAgo) {
  const base = new Date(Date.UTC(2025, 0, 30));
  base.setUTCDate(base.getUTCDate() - daysAgo);
  return base.toISOString().slice(0, 10);
}

function seededDaily() {
  const rows = [];
  let seed = 91357;
  for (let i = 29; i >= 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const noise = seed % 420;
    const index = 29 - i;
    const weekly = [0, 74, 122, 96, 168, 245, 131][index % 7];
    const visitors = 2200 + index * 47 + weekly + noise;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const revenue = Number((visitors * (24.5 + (seed % 650) / 100) + 9500 + index * 310).toFixed(2));
    rows.push({ date: isoDate(i), visitors, revenue });
  }
  return rows;
}

const categories = [
  ['Enterprise Infrastructure & Compliance', 1289340],
  ['Product Analytics', 842500],
  ['Customer Success', 421875],
  ['Acquisition', 376420],
  ['Integrations', 250115],
  ['Support', 134980]
];

const itemNames = [
  'Northwind renewal', 'Mobile funnel audit', 'Data warehouse sync', 'Retention campaign',
  'Security review', 'Partner integration', 'Executive dashboard', 'Trial expansion',
  'Billing optimization', 'Search quality report', 'Onboarding cohort', 'API consumption',
  'Quarterly planning', 'Lifecycle message', 'Compliance export', 'Forecast refresh',
  'Incident analysis', 'Feature adoption', 'Contract uplift', 'Usage anomaly'
];

async function initDb() {
  await db.query(`CREATE TABLE IF NOT EXISTS daily_metrics (date date PRIMARY KEY, visitors integer NOT NULL, revenue numeric(12,2) NOT NULL)`);
  await db.query(`CREATE TABLE IF NOT EXISTS categories (id serial PRIMARY KEY, label text NOT NULL, value integer NOT NULL)`);
  await db.query(`CREATE TABLE IF NOT EXISTS recent_items (id serial PRIMARY KEY, name text NOT NULL, category text NOT NULL, value integer NOT NULL, created_at timestamptz NOT NULL)`);
  await db.query(`CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value text NOT NULL)`);

  const count = await db.query('SELECT COUNT(*)::int AS count FROM daily_metrics');
  if ((count.rows[0]?.count ?? 0) === 0) {
    await db.query('BEGIN');
    try {
      for (const row of seededDaily()) {
        await db.query('INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)', [row.date, row.visitors, row.revenue]);
      }
      for (const [label, value] of categories) {
        await db.query('INSERT INTO categories (label, value) VALUES ($1, $2)', [label, value]);
      }
      for (let i = 0; i < 20; i++) {
        const c = categories[i % categories.length];
        const value = 18500 + ((i * 7919) % 87500);
        const d = new Date(Date.UTC(2025, 0, 30, 14, 0, 0));
        d.setUTCDate(d.getUTCDate() - i);
        await db.query(
          'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
          [itemNames[i], c[0], value, d.toISOString()]
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

function numberFromPg(value) {
  return typeof value === 'number' ? value : Number(value);
}

const app = express();
app.use(cors());
app.use(express.json());

const apiOnly = process.env.API_ONLY === '1';

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/summary', async (_req, res, next) => {
  try {
    const totals = await db.query('SELECT SUM(visitors)::int AS visitors, SUM(revenue)::numeric(12,2) AS revenue FROM daily_metrics');
    const best = await db.query('SELECT date, visitors, revenue FROM daily_metrics ORDER BY visitors DESC, revenue DESC LIMIT 1');
    const trend = await db.query(`
      WITH ordered AS (
        SELECT date, visitors, row_number() OVER (ORDER BY date DESC) AS rn FROM daily_metrics
      ), buckets AS (
        SELECT
          SUM(CASE WHEN rn BETWEEN 1 AND 7 THEN visitors ELSE 0 END)::float AS recent,
          SUM(CASE WHEN rn BETWEEN 8 AND 14 THEN visitors ELSE 0 END)::float AS prior
        FROM ordered
      ) SELECT CASE WHEN prior = 0 THEN 0 ELSE ((recent - prior) / prior) * 100 END AS trend FROM buckets
    `);
    res.json({
      totalVisitors: totals.rows[0].visitors,
      totalRevenue: numberFromPg(totals.rows[0].revenue),
      bestDay: {
        date: best.rows[0].date instanceof Date ? best.rows[0].date.toISOString().slice(0, 10) : String(best.rows[0].date).slice(0, 10),
        visitors: best.rows[0].visitors,
        revenue: numberFromPg(best.rows[0].revenue)
      },
      sevenDayTrend: Number(numberFromPg(trend.rows[0].trend).toFixed(1))
    });
  } catch (e) { next(e); }
});

app.get('/api/timeseries', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC');
    res.json(result.rows.map(r => ({ date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10), visitors: r.visitors, revenue: numberFromPg(r.revenue) })));
  } catch (e) { next(e); }
});

app.get('/api/categories', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT label, value FROM categories ORDER BY value DESC');
    res.json(result.rows);
  } catch (e) { next(e); }
});

app.get('/api/recent', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20');
    res.json(result.rows.map(r => ({ ...r, created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at })));
  } catch (e) { next(e); }
});

app.get('/api/settings', async (_req, res, next) => {
  try {
    const result = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    res.json({ theme: result.rows[0]?.value === 'dark' ? 'dark' : 'light' });
  } catch (e) { next(e); }
});

app.put('/api/settings', async (req, res, next) => {
  try {
    const theme = req.body?.theme;
    if (!['light', 'dark'].includes(theme)) return res.status(400).json({ error: 'theme must be light or dark' });
    await db.query("INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [theme]);
    res.json({ theme });
  } catch (e) { next(e); }
});

if (!apiOnly) {
  const distDir = path.join(rootDir, 'dist');
  const publicDir = fs.existsSync(distDir) ? distDir : path.join(rootDir, 'public');
  app.use(express.static(publicDir));
  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(publicDir, 'index.html'));
  });
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

await initDb();
app.listen(PORT, () => console.log(`Metrics API listening on http://127.0.0.1:${PORT}`));
