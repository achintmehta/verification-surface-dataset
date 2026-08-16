import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.join(__dirname, '..', 'data', 'pglite');

// Ensure data directory exists
fs.mkdirSync(DB_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());

// Initialize PGLite
const db = new PGlite(DB_DIR);

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
  const check = await db.query('SELECT COUNT(*) as cnt FROM daily_metrics');
  const count = parseInt(check.rows[0].cnt, 10);
  if (count > 0) {
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
  function randFloat(min, max) {
    return rand() * (max - min) + min;
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
    const revenue = parseFloat(randFloat(500, 8000).toFixed(2));
    dailyRows.push({ date: dateStr, visitors, revenue });
  }

  for (const row of dailyRows) {
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3) ON CONFLICT (date) DO NOTHING',
      [row.date, row.visitors, row.revenue]
    );
  }

  // Seed categories: 6 rows, one long label, one value >= 1,000,000
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1_284_500 },
    { name: 'Cloud Services', value: randInt(200000, 900000) },
    { name: 'Professional Services', value: randInt(50000, 400000) },
    { name: 'Support & Maintenance', value: randInt(30000, 200000) },
    { name: 'Training', value: randInt(10000, 80000) },
    { name: 'Consulting', value: randInt(15000, 120000) },
  ];

  for (const cat of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
      [cat.name, cat.value]
    );
  }

  // Seed recent_items: 20 rows
  const catNames = categories.map(c => c.name);
  const itemNames = [
    'Project Alpha', 'Project Beta', 'Project Gamma', 'Project Delta',
    'Initiative Omega', 'Initiative Sigma', 'Campaign Aurora', 'Campaign Nexus',
    'Deal Horizon', 'Deal Zenith', 'Contract Apex', 'Contract Vertex',
    'Renewal Orion', 'Renewal Lyra', 'Upgrade Titan', 'Upgrade Atlas',
    'Expansion Vega', 'Expansion Rigel', 'Pilot Cygnus', 'Pilot Draco'
  ];

  const baseTime = new Date(today);
  baseTime.setDate(baseTime.getDate() - 20);

  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = catNames[randInt(0, catNames.length - 1)];
    const value = parseFloat(randFloat(100, 50000).toFixed(2));
    const createdAt = new Date(baseTime);
    createdAt.setDate(createdAt.getDate() + i);
    createdAt.setHours(randInt(8, 18), randInt(0, 59), 0, 0);
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

// API Routes

// GET /api/summary
app.get('/api/summary', async (req, res) => {
  try {
    const totals = await db.query(`
      SELECT
        SUM(visitors)::bigint AS total_visitors,
        SUM(revenue)::numeric AS total_revenue
      FROM daily_metrics
    `);

    const bestDay = await db.query(`
      SELECT date::text AS date, visitors, revenue
      FROM daily_metrics
      ORDER BY revenue DESC
      LIMIT 1
    `);

    // 7-day trend: compare last 7 days vs previous 7 days
    const trend = await db.query(`
      WITH ordered AS (
        SELECT date, revenue, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM daily_metrics
      ),
      last7 AS (SELECT SUM(revenue) AS s FROM ordered WHERE rn <= 7),
      prev7 AS (SELECT SUM(revenue) AS s FROM ordered WHERE rn > 7 AND rn <= 14)
      SELECT
        last7.s AS last7,
        prev7.s AS prev7
      FROM last7, prev7
    `);

    const last7 = parseFloat(trend.rows[0].last7) || 0;
    const prev7 = parseFloat(trend.rows[0].prev7) || 0;
    const trendPct = prev7 === 0 ? 0 : ((last7 - prev7) / prev7) * 100;

    res.json({
      total_visitors: parseInt(totals.rows[0].total_visitors, 10),
      total_revenue: parseFloat(totals.rows[0].total_revenue),
      best_day_date: bestDay.rows[0].date,
      best_day_revenue: parseFloat(bestDay.rows[0].revenue),
      trend_pct: parseFloat(trendPct.toFixed(2))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/timeseries
app.get('/api/timeseries', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT date::text AS date, visitors, revenue::float AS revenue
      FROM daily_metrics
      ORDER BY date ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/categories
app.get('/api/categories', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT name, value
      FROM categories
      ORDER BY value DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/recent
app.get('/api/recent', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, name, category, value::float AS value, created_at
      FROM recent_items
      ORDER BY created_at DESC
      LIMIT 20
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings
app.get('/api/settings', async (req, res) => {
  try {
    const result = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    const theme = result.rows.length > 0 ? result.rows[0].value : 'light';
    res.json({ theme });
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
      return res.status(400).json({ error: 'Invalid theme value' });
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

// Start server
const PORT = process.env.PORT || 3001;

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
