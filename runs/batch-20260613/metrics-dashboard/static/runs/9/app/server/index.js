import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const PORT = process.env.PORT || 3000;
const db = new PGlite(process.env.PGLITE_DATA_DIR || './.pglite');

const app = express();
app.use(cors());
app.use(express.json());

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function isoDateDaysAgo(daysAgo) {
  const d = new Date(Date.UTC(2024, 5, 30));
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function isoDateTimeDaysAgo(daysAgo, hour) {
  const d = new Date(`${isoDateDaysAgo(daysAgo)}T${String(hour).padStart(2, '0')}:15:00.000Z`);
  return d.toISOString();
}

async function initializeDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      day DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue NUMERIC(12, 2) NOT NULL
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
  if (count.rows[0].count === 0) {
    const random = seededRandom(827364);

    for (let i = 29; i >= 0; i -= 1) {
      const index = 29 - i;
      const weekly = Math.round(Math.sin(index / 3.2) * 95);
      const visitors = 2350 + index * 41 + weekly + Math.floor(random() * 210);
      const revenue = Number((visitors * (3.65 + random() * 1.15) + 3200 + random() * 1800).toFixed(2));
      await db.query('INSERT INTO daily_metrics (day, visitors, revenue) VALUES ($1, $2, $3)', [isoDateDaysAgo(i), visitors, revenue]);
    }

    const categories = [
      ['Search & Discovery', 845230],
      ['Enterprise Infrastructure & Compliance', 1265480],
      ['Customer Success', 542110],
      ['Platform Operations', 735900],
      ['Partner Channels', 418760],
      ['Experimental Growth Labs', 287450]
    ];

    for (const [label, value] of categories) {
      await db.query('INSERT INTO categories (label, value) VALUES ($1, $2)', [label, value]);
    }

    const itemNames = [
      'Northstar rollout', 'Retention cohort review', 'Pipeline quality audit', 'Usage expansion plan',
      'Forecast reconciliation', 'Regional onboarding', 'Compliance readiness check', 'Partner scorecard',
      'Quarterly adoption push', 'Product-led trial analysis', 'Lifecycle campaign', 'Cloud capacity review',
      'Executive account mapping', 'Renewal risk sweep', 'Insight export refresh', 'Marketplace listing',
      'Engagement baseline', 'Documentation sprint', 'Pricing instrumentation', 'Support deflection plan'
    ];

    for (let i = 0; i < 20; i += 1) {
      const category = categories[i % categories.length][0];
      const value = 4200 + Math.floor(random() * 95500) + i * 725;
      await db.query(
        'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
        [itemNames[i], category, value, isoDateTimeDaysAgo(i, 9 + (i % 8))]
      );
    }
  }

  await db.query("INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING");
}

function sendError(res, error) {
  console.error(error);
  res.status(500).json({ error: 'Unable to load dashboard data' });
}

app.get('/api/summary', async (_req, res) => {
  try {
    const total = await db.query('SELECT SUM(visitors)::int AS visitors, SUM(revenue)::float8 AS revenue FROM daily_metrics');
    const best = await db.query('SELECT day::text AS day, visitors, revenue::float8 AS revenue FROM daily_metrics ORDER BY revenue DESC LIMIT 1');
    const trend = await db.query(`
      WITH ranked AS (
        SELECT day, visitors, ROW_NUMBER() OVER (ORDER BY day DESC) AS rn FROM daily_metrics
      ), grouped AS (
        SELECT
          AVG(visitors) FILTER (WHERE rn BETWEEN 1 AND 7) AS recent_avg,
          AVG(visitors) FILTER (WHERE rn BETWEEN 8 AND 14) AS previous_avg
        FROM ranked
      )
      SELECT CASE WHEN previous_avg = 0 THEN 0 ELSE ((recent_avg - previous_avg) / previous_avg * 100) END::float8 AS trend FROM grouped
    `);

    res.json({
      totalVisitors: total.rows[0].visitors,
      totalRevenue: Number(total.rows[0].revenue.toFixed(2)),
      bestDay: best.rows[0],
      sevenDayTrend: Number(trend.rows[0].trend.toFixed(2))
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/timeseries', async (_req, res) => {
  try {
    const result = await db.query('SELECT day::text AS date, visitors, revenue::float8 AS revenue FROM daily_metrics ORDER BY day');
    res.json(result.rows);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/categories', async (_req, res) => {
  try {
    const result = await db.query('SELECT label, value FROM categories ORDER BY value DESC');
    res.json(result.rows);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/recent', async (_req, res) => {
  try {
    const result = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20');
    res.json(result.rows);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/settings', async (_req, res) => {
  try {
    const result = await db.query("SELECT value AS theme FROM settings WHERE key = 'theme'");
    res.json({ theme: result.rows[0]?.theme === 'dark' ? 'dark' : 'light' });
  } catch (error) {
    sendError(res, error);
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const theme = req.body?.theme;
    if (!['light', 'dark'].includes(theme)) {
      res.status(400).json({ error: 'theme must be light or dark' });
      return;
    }
    await db.query("INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [theme]);
    res.json({ theme });
  } catch (error) {
    sendError(res, error);
  }
});

await initializeDatabase();
app.listen(PORT, () => {
  console.log(`metrics-dashboard API listening on http://localhost:${PORT}`);
});
