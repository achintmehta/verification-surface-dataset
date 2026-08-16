import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'pgdata');

const app = express();
app.use(cors());
app.use(express.json());

let db;

// Deterministic seed helpers
function seededRandom(seed) {
  let s = seed;
  return function () {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

async function initDB() {
  db = new PGlite(DB_PATH);

  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue NUMERIC(12,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      value INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      value NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Check if already seeded
  const check = await db.query('SELECT count(*)::int AS cnt FROM daily_metrics');
  if (check.rows[0].cnt > 0) {
    console.log('Database already seeded.');
    return;
  }

  console.log('Seeding database...');
  const rand = seededRandom(42);

  // Seed daily_metrics – 30 days ending today-like fixed date (2025-01-30)
  const baseDate = new Date('2025-01-01');
  for (let i = 0; i < 30; i++) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const visitors = Math.floor(rand() * 4000) + 500;
    const revenue = Math.floor(rand() * 50000 + 1000) + rand() * 100;
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, visitors, parseFloat(revenue.toFixed(2))]
    );
  }

  // Seed categories – 6 rows, one long name, one value >= 1,000,000
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1284503 },
    { name: 'Cloud Services', value: 842910 },
    { name: 'Data Analytics', value: 631200 },
    { name: 'Mobile Apps', value: 425780 },
    { name: 'Security', value: 318450 },
    { name: 'IoT Devices', value: 209130 },
  ];
  for (const cat of categories) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [
      cat.name,
      cat.value,
    ]);
  }

  // Seed recent_items – 20 rows
  const itemNames = [
    'Alpha Widget', 'Beta Module', 'Gamma Engine', 'Delta Processor',
    'Epsilon Service', 'Zeta Framework', 'Eta Pipeline', 'Theta Gateway',
    'Iota Monitor', 'Kappa Scheduler', 'Lambda Router', 'Mu Adapter',
    'Nu Connector', 'Xi Transformer', 'Omicron Cache', 'Pi Balancer',
    'Rho Aggregator', 'Sigma Dispatcher', 'Tau Serializer', 'Upsilon Encoder',
  ];
  const catNames = categories.map((c) => c.name);
  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value = parseFloat((rand() * 10000 + 100).toFixed(2));
    const createdAt = new Date(baseDate);
    createdAt.setDate(createdAt.getDate() + Math.floor(rand() * 30));
    createdAt.setHours(Math.floor(rand() * 24), Math.floor(rand() * 60));
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, createdAt.toISOString()]
    );
  }

  // Seed settings
  await db.query(
    "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING"
  );

  console.log('Seed complete.');
}

// --- API Routes ---

// GET /api/summary
app.get('/api/summary', async (_req, res) => {
  try {
    const totalVisitors = await db.query(
      'SELECT COALESCE(SUM(visitors), 0)::int AS total FROM daily_metrics'
    );
    const totalRevenue = await db.query(
      'SELECT COALESCE(SUM(revenue), 0)::numeric AS total FROM daily_metrics'
    );
    const bestDay = await db.query(
      'SELECT date, revenue FROM daily_metrics ORDER BY revenue DESC LIMIT 1'
    );
    // 7-day trend: compare last 7 days avg to previous 7 days avg
    const trend = await db.query(`
      WITH ordered AS (
        SELECT revenue, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM daily_metrics
      ),
      recent AS (SELECT AVG(revenue) AS avg_rev FROM ordered WHERE rn <= 7),
      prior  AS (SELECT AVG(revenue) AS avg_rev FROM ordered WHERE rn > 7 AND rn <= 14)
      SELECT
        CASE WHEN prior.avg_rev = 0 THEN 0
             ELSE ROUND(((recent.avg_rev - prior.avg_rev) / prior.avg_rev * 100)::numeric, 1)
        END AS trend_pct
      FROM recent, prior
    `);

    res.json({
      totalVisitors: totalVisitors.rows[0].total,
      totalRevenue: parseFloat(totalRevenue.rows[0].total),
      bestDay: bestDay.rows[0]
        ? { date: bestDay.rows[0].date, revenue: parseFloat(bestDay.rows[0].revenue) }
        : null,
      trendPct: trend.rows[0] ? parseFloat(trend.rows[0].trend_pct) : 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

// GET /api/timeseries
app.get('/api/timeseries', async (_req, res) => {
  try {
    const result = await db.query(
      'SELECT date, visitors, revenue::float FROM daily_metrics ORDER BY date ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch timeseries' });
  }
});

// GET /api/categories
app.get('/api/categories', async (_req, res) => {
  try {
    const result = await db.query(
      'SELECT name, value FROM categories ORDER BY value DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// GET /api/recent
app.get('/api/recent', async (_req, res) => {
  try {
    const result = await db.query(
      'SELECT name, category, value::float, created_at FROM recent_items ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch recent items' });
  }
});

// GET /api/settings
app.get('/api/settings', async (_req, res) => {
  try {
    const result = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    const theme = result.rows.length > 0 ? result.rows[0].value : 'light';
    res.json({ theme });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// PUT /api/settings
app.put('/api/settings', async (req, res) => {
  try {
    const { theme } = req.body;
    if (!theme || !['light', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'Invalid theme value' });
    }
    await db.query(
      "INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [theme]
    );
    res.json({ theme });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Start
const PORT = process.env.PORT || 3001;

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`API server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
