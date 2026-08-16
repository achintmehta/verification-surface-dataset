import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs/promises';
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

function seededRandom(seed = 424242) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function sqlQuote(value) {
  return String(value).replaceAll("'", "''");
}

function isoDate(daysAgo) {
  const d = new Date(Date.UTC(2025, 0, 30));
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function isoDateTime(daysAgo, hour = 12) {
  const d = new Date(Date.UTC(2025, 0, 30, hour, 15, 0));
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString();
}

async function initializeDatabase() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      metric_date DATE NOT NULL UNIQUE,
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

  const existing = await db.query('SELECT COUNT(*)::int AS count FROM daily_metrics');
  if ((existing.rows[0]?.count ?? 0) === 0) {
    const rand = seededRandom();
    const dailyValues = [];
    for (let i = 29; i >= 0; i--) {
      const dayIndex = 29 - i;
      const weekdayBoost = dayIndex % 7 < 5 ? 190 : -80;
      const visitors = Math.round(2450 + dayIndex * 42 + weekdayBoost + rand() * 520);
      const revenue = Number((visitors * (18.5 + rand() * 9) + 9000 + dayIndex * 210).toFixed(2));
      dailyValues.push(`('${isoDate(i)}', ${visitors}, ${revenue})`);
    }

    const categoryRows = [
      ['Enterprise Infrastructure & Compliance', 1250000],
      ['Self-Serve Analytics', 842300],
      ['Mobile Growth', 618400],
      ['Partner Channel', 455900],
      ['Lifecycle Email', 296700],
      ['Experimental Labs', 174250]
    ];

    const itemNames = [
      'Northwind renewal', 'Apex onboarding', 'Quarterly expansion', 'Beacon conversion',
      'Helio migration', 'Summit enablement', 'Atlas pilot', 'Cobalt upgrade',
      'Riverbank audit', 'Nimbus rollout', 'Keystone package', 'Orbit expansion',
      'Pioneer activation', 'Vector review', 'Granite renewal', 'Lumen adoption',
      'Acorn launch', 'Harbor health check', 'Prairie conversion', 'Redwood upgrade'
    ];
    const recentRows = itemNames.map((name, index) => {
      const c = categoryRows[index % categoryRows.length][0];
      const value = 18000 + Math.round(rand() * 180000) + index * 1400;
      return `('${sqlQuote(name)}', '${sqlQuote(c)}', ${value}, '${isoDateTime(index, 9 + (index % 9))}')`;
    });

    await db.exec('BEGIN');
    try {
      await db.exec(`INSERT INTO daily_metrics (metric_date, visitors, revenue) VALUES ${dailyValues.join(',')}`);
      await db.exec(`INSERT INTO categories (label, value) VALUES ${categoryRows.map(([label, value]) => `('${sqlQuote(label)}', ${value})`).join(',')}`);
      await db.exec(`INSERT INTO recent_items (name, category, value, created_at) VALUES ${recentRows.join(',')}`);
      await db.exec(`INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING`);
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  } else {
    await db.exec(`INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING`);
  }
}

function numericRow(row) {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]));
}

app.get('/api/summary', async (_req, res, next) => {
  try {
    const totals = await db.query(`
      SELECT COALESCE(SUM(visitors), 0)::int AS total_visitors,
             COALESCE(SUM(revenue), 0)::float8 AS total_revenue
      FROM daily_metrics
    `);
    const best = await db.query(`
      SELECT metric_date::text AS date, visitors, revenue::float8 AS revenue
      FROM daily_metrics
      ORDER BY visitors DESC, revenue DESC
      LIMIT 1
    `);
    const trend = await db.query(`
      WITH ordered AS (
        SELECT metric_date, visitors, ROW_NUMBER() OVER (ORDER BY metric_date DESC) AS rn
        FROM daily_metrics
      ), sums AS (
        SELECT
          SUM(visitors) FILTER (WHERE rn BETWEEN 1 AND 7)::float8 AS last7,
          SUM(visitors) FILTER (WHERE rn BETWEEN 8 AND 14)::float8 AS prev7
        FROM ordered
      )
      SELECT CASE WHEN prev7 IS NULL OR prev7 = 0 THEN 0 ELSE ((last7 - prev7) / prev7) * 100 END::float8 AS trend_percent
      FROM sums
    `);

    res.json({
      totalVisitors: Number(totals.rows[0].total_visitors),
      totalRevenue: Number(totals.rows[0].total_revenue),
      bestDay: numericRow(best.rows[0]),
      sevenDayTrendPercent: Number(trend.rows[0].trend_percent)
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/timeseries', async (_req, res, next) => {
  try {
    const result = await db.query(`
      SELECT metric_date::text AS date, visitors::int AS visitors, revenue::float8 AS revenue
      FROM daily_metrics
      ORDER BY metric_date ASC
    `);
    res.json(result.rows.map(numericRow));
  } catch (error) {
    next(error);
  }
});

app.get('/api/categories', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT label, value::int AS value FROM categories ORDER BY value DESC');
    res.json(result.rows.map(numericRow));
  } catch (error) {
    next(error);
  }
});

app.get('/api/recent', async (_req, res, next) => {
  try {
    const result = await db.query(`
      SELECT name, category, value::int AS value, created_at::text AS created_at
      FROM recent_items
      ORDER BY created_at DESC
      LIMIT 20
    `);
    res.json(result.rows.map(numericRow));
  } catch (error) {
    next(error);
  }
});

app.get('/api/settings', async (_req, res, next) => {
  try {
    const result = await db.query("SELECT value AS theme FROM settings WHERE key = 'theme'");
    const theme = result.rows[0]?.theme === 'dark' ? 'dark' : 'light';
    res.json({ theme });
  } catch (error) {
    next(error);
  }
});

app.put('/api/settings', async (req, res, next) => {
  try {
    const theme = req.body?.theme;
    if (!['light', 'dark'].includes(theme)) {
      res.status(400).json({ error: 'theme must be "light" or "dark"' });
      return;
    }
    await db.query("INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [theme]);
    res.json({ theme });
  } catch (error) {
    next(error);
  }
});

app.use(async (req, res, next) => {
  if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) {
    try {
      const result = await db.query("SELECT value AS theme FROM settings WHERE key = 'theme'");
      const theme = result.rows[0]?.theme === 'dark' ? 'dark' : 'light';
      const html = await fs.readFile(path.join(rootDir, 'dist', 'index.html'), 'utf8');
      res.type('html').send(html.replace('<html lang="en" data-theme="light">', `<html lang="en" data-theme="${theme}">`));
    } catch (error) {
      next(error);
    }
    return;
  }
  next();
});
app.use(express.static(path.join(rootDir, 'dist')));
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    res.sendFile(path.join(rootDir, 'dist', 'index.html'));
    return;
  }
  next();
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
});

await initializeDatabase();
app.listen(PORT, () => {
  console.log(`Metrics API listening on http://localhost:${PORT}`);
});
