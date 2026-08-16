import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(path.join(__dirname, 'data', 'pglite'));

function mulberry32(seed) {
  return function random() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isoDate(daysFromStart) {
  const d = new Date(Date.UTC(2025, 0, 1 + daysFromStart));
  return d.toISOString().slice(0, 10);
}

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      metric_date date PRIMARY KEY,
      visitors integer NOT NULL,
      revenue numeric(12,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id serial PRIMARY KEY,
      label text NOT NULL,
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

  const existing = await db.query('SELECT COUNT(*)::int AS count FROM daily_metrics');
  if (existing.rows[0].count === 0) {
    await seedDb();
  }

  await db.query(`
    INSERT INTO settings (key, value) VALUES ('theme', 'light')
    ON CONFLICT (key) DO NOTHING;
  `);
}

async function seedDb() {
  const rnd = mulberry32(424242);
  await db.query('BEGIN');
  try {
    for (let i = 0; i < 30; i += 1) {
      const weekdayBoost = [0, 6].includes((i + 3) % 7) ? -210 : 180;
      const visitors = Math.round(2650 + i * 57 + Math.sin(i / 3) * 360 + weekdayBoost + rnd() * 420);
      const revenue = Math.round((visitorRevenue(visitors, i, rnd) + Number.EPSILON) * 100) / 100;
      await db.query(
        'INSERT INTO daily_metrics (metric_date, visitors, revenue) VALUES ($1, $2, $3)',
        [isoDate(i), visitors, revenue]
      );
    }

    const categories = [
      ['Product Analytics', 742300],
      ['Enterprise Infrastructure & Compliance', 1247500],
      ['Growth & Acquisition', 586120],
      ['Customer Success', 398440],
      ['Operations', 267900],
      ['Experimental Labs', 154680]
    ];
    for (const [label, value] of categories) {
      await db.query('INSERT INTO categories (label, value) VALUES ($1, $2)', [label, value]);
    }

    const itemCategories = categories.map(([label]) => label);
    for (let i = 0; i < 20; i += 1) {
      const category = itemCategories[i % itemCategories.length];
      const name = `${['Pipeline', 'Segment', 'Campaign', 'Account', 'Report'][i % 5]} ${String.fromCharCode(65 + i)}${100 + i}`;
      const value = Math.round(8200 + rnd() * 92000 + i * 1375);
      const created = new Date(Date.UTC(2025, 0, 30 - Math.floor(i / 2), 9 + (i % 9), (i * 7) % 60));
      await db.query(
        'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
        [name, category, value, created.toISOString()]
      );
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

function visitorRevenue(visitors, i, rnd) {
  const conversion = 15.4 + Math.sin(i / 4) * 1.8 + rnd() * 2.6;
  return visitors * conversion;
}

function mapDaily(row) {
  return {
    date: row.metric_date instanceof Date ? row.metric_date.toISOString().slice(0, 10) : String(row.metric_date).slice(0, 10),
    visitors: Number(row.visitors),
    revenue: Number(row.revenue)
  };
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/summary', async (_req, res, next) => {
  try {
    const totals = await db.query(`
      SELECT COALESCE(SUM(visitors),0)::int AS total_visitors,
             COALESCE(SUM(revenue),0)::float8 AS total_revenue
      FROM daily_metrics
    `);
    const best = await db.query(`
      SELECT metric_date, visitors, revenue
      FROM daily_metrics
      ORDER BY visitors DESC, metric_date ASC
      LIMIT 1
    `);
    const trend = await db.query(`
      WITH ranked AS (
        SELECT metric_date, visitors,
               row_number() OVER (ORDER BY metric_date DESC) AS rn
        FROM daily_metrics
      ), sums AS (
        SELECT
          SUM(visitors) FILTER (WHERE rn BETWEEN 1 AND 7)::float8 AS current_visitors,
          SUM(visitors) FILTER (WHERE rn BETWEEN 8 AND 14)::float8 AS previous_visitors
        FROM ranked
      )
      SELECT CASE WHEN previous_visitors = 0 THEN 0
                  ELSE ((current_visitors - previous_visitors) / previous_visitors) * 100 END AS trend_pct
      FROM sums
    `);

    res.json({
      totalVisitors: Number(totals.rows[0].total_visitors),
      totalRevenue: Number(totals.rows[0].total_revenue),
      bestDay: mapDaily(best.rows[0]),
      sevenDayTrendPct: Number(trend.rows[0].trend_pct)
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/timeseries', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT metric_date, visitors, revenue FROM daily_metrics ORDER BY metric_date ASC');
    res.json(result.rows.map(mapDaily));
  } catch (error) {
    next(error);
  }
});

app.get('/api/categories', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT id, label, value FROM categories ORDER BY value DESC, id ASC');
    res.json(result.rows.map((row) => ({ id: Number(row.id), label: row.label, value: Number(row.value) })));
  } catch (error) {
    next(error);
  }
});

app.get('/api/recent', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT id, name, category, value, created_at FROM recent_items ORDER BY created_at DESC, id DESC LIMIT 20');
    res.json(result.rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      category: row.category,
      value: Number(row.value),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString()
    })));
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
    if (!['light', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    await db.query(
      "INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [theme]
    );
    res.json({ theme });
  } catch (error) {
    next(error);
  }
});

const dist = path.join(__dirname, 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Metrics dashboard API listening on http://localhost:${PORT}`);
  });
}).catch((error) => {
  console.error('Failed to initialize database', error);
  process.exit(1);
});
