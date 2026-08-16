import express from 'express';
import cors from 'cors';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'pglite-data');
await mkdir(dataDir, { recursive: true });

const db = new PGlite(dataDir);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

function seededRandom(seed = 42573) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function isoDate(daysFromStart) {
  const d = new Date(Date.UTC(2024, 5, 1 + daysFromStart));
  return d.toISOString().slice(0, 10);
}

function isoDateTime(daysFromStart, hour = 12) {
  const d = new Date(Date.UTC(2024, 5, 1 + daysFromStart, hour, 30, 0));
  return d.toISOString();
}

async function initDatabase() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      day date PRIMARY KEY,
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
      id integer PRIMARY KEY DEFAULT 1,
      theme text NOT NULL CHECK (theme IN ('light', 'dark'))
    );
  `);

  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM daily_metrics');
  if (rows[0].count > 0) {
    await db.query("INSERT INTO settings (id, theme) VALUES (1, 'light') ON CONFLICT (id) DO NOTHING");
    return;
  }

  const rnd = seededRandom();
  for (let i = 0; i < 30; i++) {
    const weeklyPulse = Math.round(Math.sin(i / 4.2) * 140);
    const visitors = 1280 + i * 32 + weeklyPulse + Math.floor(rnd() * 180);
    const revenue = Number((visitors * (18 + rnd() * 12) + 8500 + i * 173).toFixed(2));
    await db.query('INSERT INTO daily_metrics (day, visitors, revenue) VALUES ($1, $2, $3)', [isoDate(i), visitors, revenue]);
  }

  const categories = [
    ['Search', 684200],
    ['Direct', 412780],
    ['Enterprise Infrastructure & Compliance', 1254320],
    ['Partner Referrals', 298430],
    ['Email Campaigns', 185920],
    ['Social Media', 143650]
  ];
  for (const [label, value] of categories) {
    await db.query('INSERT INTO categories (label, value) VALUES ($1, $2)', [label, value]);
  }

  const itemNames = [
    'Northstar account expansion', 'Q3 renewal intake', 'Regional traffic audit', 'Compliance review pack',
    'Partner co-sell brief', 'Lifecycle nurture cohort', 'Executive dashboard export', 'Enterprise pilot kickoff',
    'Search intent analysis', 'Pricing page experiment', 'Referral quality sweep', 'Email segment refresh',
    'Social launch recap', 'Infrastructure readiness check', 'Mobile funnel review', 'Revenue attribution pass',
    'Customer success handoff', 'Demand forecast update', 'Weekly marketing digest', 'Board metrics packet'
  ];
  for (let i = 0; i < 20; i++) {
    const category = categories[i % categories.length][0];
    const value = 1800 + Math.floor(rnd() * 94000) + i * 640;
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [itemNames[i], category, value, isoDateTime(29 - i, 9 + (i % 9))]
    );
  }

  await db.query("INSERT INTO settings (id, theme) VALUES (1, 'light') ON CONFLICT (id) DO NOTHING");
}

await initDatabase();

app.get('/api/summary', async (_req, res, next) => {
  try {
    const totals = await db.query(`
      SELECT
        SUM(visitors)::int AS total_visitors,
        ROUND(SUM(revenue)::numeric, 2)::text AS total_revenue
      FROM daily_metrics
    `);
    const best = await db.query(`
      SELECT day::text, visitors, revenue::text
      FROM daily_metrics
      ORDER BY visitors DESC, revenue DESC
      LIMIT 1
    `);
    const trend = await db.query(`
      WITH numbered AS (
        SELECT visitors, ROW_NUMBER() OVER (ORDER BY day DESC) AS rn
        FROM daily_metrics
      ), sums AS (
        SELECT
          SUM(visitors) FILTER (WHERE rn BETWEEN 1 AND 7)::numeric AS last_7,
          SUM(visitors) FILTER (WHERE rn BETWEEN 8 AND 14)::numeric AS prev_7
        FROM numbered
      )
      SELECT ROUND(((last_7 - prev_7) / NULLIF(prev_7, 0) * 100), 1)::text AS trend_pct
      FROM sums
    `);

    res.json({
      totalVisitors: totals.rows[0].total_visitors,
      totalRevenue: Number(totals.rows[0].total_revenue),
      bestDay: {
        date: best.rows[0].day,
        visitors: best.rows[0].visitors,
        revenue: Number(best.rows[0].revenue)
      },
      sevenDayTrendPct: Number(trend.rows[0].trend_pct)
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/timeseries', async (_req, res, next) => {
  try {
    const { rows } = await db.query('SELECT day::text AS date, visitors, revenue::text FROM daily_metrics ORDER BY day ASC');
    res.json(rows.map((r) => ({ date: r.date, visitors: r.visitors, revenue: Number(r.revenue) })));
  } catch (err) {
    next(err);
  }
});

app.get('/api/categories', async (_req, res, next) => {
  try {
    const { rows } = await db.query('SELECT label, value FROM categories ORDER BY value DESC');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.get('/api/recent', async (_req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT id, name, category, value, created_at AS "createdAt"
      FROM recent_items
      ORDER BY created_at DESC
      LIMIT 20
    `);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.get('/api/settings', async (_req, res, next) => {
  try {
    const { rows } = await db.query("SELECT theme FROM settings WHERE id = 1");
    res.json({ theme: rows[0]?.theme || 'light' });
  } catch (err) {
    next(err);
  }
});

app.put('/api/settings', async (req, res, next) => {
  try {
    const { theme } = req.body || {};
    if (!['light', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    await db.query(
      'INSERT INTO settings (id, theme) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET theme = EXCLUDED.theme',
      [theme]
    );
    res.json({ theme });
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

app.listen(PORT, () => {
  console.log(`Metrics API listening on http://localhost:${PORT}`);
});
