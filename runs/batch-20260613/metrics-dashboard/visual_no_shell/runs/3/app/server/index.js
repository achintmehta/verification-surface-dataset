import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, '..', 'data', 'pglite');

// Ensure data directory exists
mkdirSync(DB_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());

// Initialize PGLite
const db = new PGlite(DB_DIR);

// ─── Schema & Seed ────────────────────────────────────────────────────────────

async function initDB() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue NUMERIC(12,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      value BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      value NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Check if already seeded
  const { rows } = await db.query('SELECT COUNT(*) as cnt FROM daily_metrics');
  if (parseInt(rows[0].cnt, 10) > 0) {
    console.log('Database already seeded, skipping.');
    return;
  }

  console.log('Seeding database...');

  // Deterministic seed using a simple LCG PRNG
  // seed = 42
  let seed = 42;
  function rand() {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    return (seed >>> 0) / 0xffffffff;
  }
  function randInt(min, max) {
    return Math.floor(rand() * (max - min + 1)) + min;
  }

  // Seed daily_metrics: 30 days ending yesterday
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dailyRows = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const visitors = randInt(800, 5000);
    const revenue = (rand() * 4500 + 500).toFixed(2);
    dailyRows.push({ date: dateStr, visitors, revenue });
  }

  for (const row of dailyRows) {
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3) ON CONFLICT (date) DO NOTHING',
      [row.date, row.visitors, row.revenue]
    );
  }

  // Seed categories (6 rows, one long label, one value >= 1,000,000)
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1_284_500 },
    { name: 'Cloud Services', value: randInt(200000, 800000) },
    { name: 'Analytics', value: randInt(50000, 199000) },
    { name: 'Security', value: randInt(30000, 90000) },
    { name: 'Support', value: randInt(10000, 29000) },
    { name: 'Training', value: randInt(5000, 9999) },
  ];

  for (const cat of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
      [cat.name, cat.value]
    );
  }

  // Seed recent_items (20 rows)
  const catNames = categories.map(c => c.name);
  const itemNames = [
    'Project Alpha', 'Project Beta', 'Project Gamma', 'Project Delta',
    'Initiative Omega', 'Campaign Zeta', 'Operation Sigma', 'Task Epsilon',
    'Module Theta', 'Service Lambda', 'Feature Kappa', 'Sprint Mu',
    'Release Nu', 'Patch Xi', 'Hotfix Pi', 'Rollout Rho',
    'Audit Tau', 'Review Upsilon', 'Deploy Phi', 'Monitor Chi'
  ];

  const baseTime = new Date(today);
  baseTime.setDate(baseTime.getDate() - 20);

  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value = (rand() * 9900 + 100).toFixed(2);
    const createdAt = new Date(baseTime.getTime() + i * 86400000 * rand());
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, createdAt.toISOString()]
    );
  }

  // Default settings
  await db.query(
    "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING"
  );

  console.log('Database seeded successfully.');
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// GET /api/summary
app.get('/api/summary', async (req, res) => {
  try {
    const totalVisitors = await db.query('SELECT SUM(visitors) as total FROM daily_metrics');
    const totalRevenue = await db.query('SELECT SUM(revenue) as total FROM daily_metrics');
    const bestDay = await db.query(
      'SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1'
    );

    // 7-day trend: compare last 7 days vs previous 7 days
    const trend = await db.query(`
      WITH ordered AS (
        SELECT date, visitors, ROW_NUMBER() OVER (ORDER BY date DESC) as rn
        FROM daily_metrics
      ),
      last7 AS (SELECT AVG(visitors) as avg FROM ordered WHERE rn <= 7),
      prev7 AS (SELECT AVG(visitors) as avg FROM ordered WHERE rn > 7 AND rn <= 14)
      SELECT
        CASE WHEN prev7.avg = 0 THEN 0
             ELSE ROUND(((last7.avg - prev7.avg) / prev7.avg * 100)::numeric, 1)
        END as trend_pct
      FROM last7, prev7
    `);

    res.json({
      totalVisitors: parseInt(totalVisitors.rows[0].total, 10),
      totalRevenue: parseFloat(totalRevenue.rows[0].total),
      bestDay: {
        date: bestDay.rows[0].date,
        visitors: parseInt(bestDay.rows[0].visitors, 10),
      },
      trendPct: parseFloat(trend.rows[0].trend_pct),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/timeseries
app.get('/api/timeseries', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC'
    );
    res.json(rows.map(r => ({
      date: r.date,
      visitors: parseInt(r.visitors, 10),
      revenue: parseFloat(r.revenue),
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/categories
app.get('/api/categories', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT name, value FROM categories ORDER BY value DESC'
    );
    res.json(rows.map(r => ({
      name: r.name,
      value: parseInt(r.value, 10),
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/recent
app.get('/api/recent', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20'
    );
    res.json(rows.map(r => ({
      name: r.name,
      category: r.category,
      value: parseFloat(r.value),
      createdAt: r.created_at,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings
app.get('/api/settings', async (req, res) => {
  try {
    const { rows } = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    res.json({ theme: rows[0]?.value ?? 'light' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings
app.put('/api/settings', async (req, res) => {
  try {
    const { theme } = req.body;
    if (!['light', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    await db.query(
      "INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [theme]
    );
    res.json({ theme });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
