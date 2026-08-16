import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', 'pglite-data');

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(DATA_DIR);

const round2 = (value) => Math.round(Number(value) * 100) / 100;

async function initializeDatabase() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      metric_date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL CHECK (visitors >= 0),
      revenue NUMERIC(12,2) NOT NULL CHECK (revenue >= 0)
    );

    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      label TEXT NOT NULL UNIQUE,
      value INTEGER NOT NULL CHECK (value >= 0)
    );

    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      value INTEGER NOT NULL CHECK (value >= 0),
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const existing = await db.query('SELECT COUNT(*)::int AS count FROM daily_metrics');
  if (Number(existing.rows[0]?.count || 0) > 0) {
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('theme', 'light')
       ON CONFLICT (key) DO NOTHING`
    );
    return;
  }

  await db.exec('BEGIN');
  try {
    await db.query(`INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING`);

    const start = new Date(Date.UTC(2024, 0, 1));
    for (let i = 0; i < 30; i += 1) {
      const date = new Date(start);
      date.setUTCDate(start.getUTCDate() + i);
      const iso = date.toISOString().slice(0, 10);
      const visitors = 18500 + i * 730 + ((i * 137) % 2400) + (i % 6 === 0 ? 3100 : 0);
      const revenue = 46200 + i * 1450 + ((i * i * 97) % 8200) + (i % 5 === 2 ? 9200 : 0);
      await db.query(
        'INSERT INTO daily_metrics (metric_date, visitors, revenue) VALUES ($1, $2, $3)',
        [iso, visitors, revenue.toFixed(2)]
      );
    }

    const categories = [
      ['Enterprise Infrastructure & Compliance', 1275480],
      ['Self-Service Analytics', 842150],
      ['Workflow Automation', 615930],
      ['Customer Success', 391240],
      ['Data Quality', 274880],
      ['Experimental Labs', 158420],
    ];
    for (const [label, value] of categories) {
      await db.query('INSERT INTO categories (label, value) VALUES ($1, $2)', [label, value]);
    }

    const itemCategories = categories.map(([label]) => label);
    for (let i = 0; i < 20; i += 1) {
      const date = new Date(Date.UTC(2024, 0, 30, 12, 0, 0));
      date.setUTCDate(date.getUTCDate() - i);
      const category = itemCategories[(i * 2 + 1) % itemCategories.length];
      const value = 18000 + ((i * 7919) % 126000) + (i === 3 ? 1000000 : 0);
      const name = `Metric review ${String(i + 1).padStart(2, '0')}`;
      await db.query(
        'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
        [name, category, value, date.toISOString()]
      );
    }

    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
}

function numericRow(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (typeof value === 'bigint') return [key, Number(value)];
      if (value !== null && value !== '' && !Number.isNaN(Number(value)) && ['visitors', 'revenue', 'value', 'total_visitors', 'total_revenue', 'trend_percent'].includes(key)) {
        return [key, Number(value)];
      }
      return [key, value];
    })
  );
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/summary', async (_req, res, next) => {
  try {
    const totals = await db.query(`
      SELECT COALESCE(SUM(visitors), 0)::int AS total_visitors,
             COALESCE(SUM(revenue), 0)::numeric(12,2) AS total_revenue
      FROM daily_metrics
    `);
    const best = await db.query(`
      SELECT metric_date::text AS date, visitors, revenue
      FROM daily_metrics
      ORDER BY revenue DESC, visitors DESC
      LIMIT 1
    `);
    const trend = await db.query(`
      WITH ordered AS (
        SELECT metric_date, visitors,
               ROW_NUMBER() OVER (ORDER BY metric_date DESC) AS rn
        FROM daily_metrics
      ), periods AS (
        SELECT
          AVG(visitors) FILTER (WHERE rn BETWEEN 1 AND 7) AS current_avg,
          AVG(visitors) FILTER (WHERE rn BETWEEN 8 AND 14) AS previous_avg
        FROM ordered
      )
      SELECT CASE WHEN previous_avg = 0 OR previous_avg IS NULL THEN 0
                  ELSE ((current_avg - previous_avg) / previous_avg * 100)
             END::numeric(8,2) AS trend_percent
      FROM periods
    `);

    const totalRow = numericRow(totals.rows[0]);
    const bestRow = numericRow(best.rows[0]);
    res.json({
      totalVisitors: totalRow.total_visitors,
      totalRevenue: round2(totalRow.total_revenue),
      bestDay: bestRow,
      sevenDayTrendPercent: round2(trend.rows[0]?.trend_percent || 0),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/timeseries', async (_req, res, next) => {
  try {
    const result = await db.query(`
      SELECT metric_date::text AS date, visitors::int AS visitors, revenue::numeric(12,2) AS revenue
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
    if (theme !== 'light' && theme !== 'dark') {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('theme', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [theme]
    );
    res.json({ theme });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(__dirname, '..', 'dist')));
app.get(/^\/(?!api).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Metrics dashboard API listening on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize database', error);
    process.exit(1);
  });
