const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const DB_PATH = path.join(__dirname, '..', 'pgdata');
const SEED_VERSION = 2; // Bump to force reseed

let db;

// Deterministic seed random number generator (mulberry32)
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function initDatabase() {
  db = new PGlite(DB_PATH);

  // Check if already seeded
  const tableCheck = await db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables WHERE table_name = 'daily_metrics'
    ) AS exists
  `);

  if (tableCheck.rows[0].exists) {
    // Check seed version
    try {
      const versionCheck = await db.query("SELECT value FROM settings WHERE key = 'seed_version'");
      if (versionCheck.rows.length > 0 && parseInt(versionCheck.rows[0].value) >= SEED_VERSION) {
        console.log('Database already seeded at version', SEED_VERSION);
        return;
      }
    } catch (e) {
      // settings table may not have seed_version yet
    }
    // Drop old tables for reseed
    console.log('Reseeding database to version', SEED_VERSION);
    await db.query('DROP TABLE IF EXISTS daily_metrics, categories, recent_items, settings CASCADE');
  }

  console.log('Creating schema and seeding data...');

  // Create tables
  await db.query(`
    CREATE TABLE daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL,
      visitors INTEGER NOT NULL,
      revenue NUMERIC(12, 2) NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      value INTEGER NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE recent_items (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(255) NOT NULL,
      value NUMERIC(12, 2) NOT NULL,
      created_at TIMESTAMP NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE settings (
      key VARCHAR(64) PRIMARY KEY,
      value VARCHAR(255) NOT NULL
    );
  `);

  // Seed with deterministic data
  const rng = mulberry32(42);

  // 30 days of daily_metrics
  const baseDate = new Date('2024-12-01');
  for (let i = 0; i < 30; i++) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    const visitors = Math.floor(rng() * 50000) + 30000;
    const revenue = Math.floor(rng() * 500000) / 100 + 1000;
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, visitors, revenue.toFixed(2)]
    );
  }

  // 6 categories (one long name, one value >= 1,000,000)
  const categoryData = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1250000 },
    { name: 'Marketing', value: 345000 },
    { name: 'Sales', value: 780000 },
    { name: 'Engineering', value: 520000 },
    { name: 'Analytics', value: 190000 },
    { name: 'Support', value: 410000 },
  ];
  for (const cat of categoryData) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [
      cat.name,
      cat.value,
    ]);
  }

  // 20 recent items
  const itemCategories = ['Marketing', 'Sales', 'Engineering', 'Analytics', 'Support', 'Enterprise Infrastructure & Compliance'];
  const itemNames = [
    'Alpha Report', 'Beta Analysis', 'Gamma Overview', 'Delta Summary',
    'Epsilon Audit', 'Zeta Review', 'Eta Metrics', 'Theta Dashboard',
    'Iota Pipeline', 'Kappa Survey', 'Lambda Forecast', 'Mu Benchmark',
    'Nu Assessment', 'Xi Evaluation', 'Omicron Digest', 'Pi Snapshot',
    'Rho Tracker', 'Sigma Monitor', 'Tau Insights', 'Upsilon Trends'
  ];
  for (let i = 0; i < 20; i++) {
    const cat = itemCategories[Math.floor(rng() * itemCategories.length)];
    const val = (Math.floor(rng() * 100000) / 100 + 10).toFixed(2);
    const createdAt = new Date(baseDate);
    createdAt.setDate(createdAt.getDate() + Math.floor(rng() * 30));
    createdAt.setHours(Math.floor(rng() * 24), Math.floor(rng() * 60));
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [itemNames[i], cat, val, createdAt.toISOString()]
    );
  }

  // Default theme and seed version
  await db.query("INSERT INTO settings (key, value) VALUES ('theme', 'light')");
  await db.query("INSERT INTO settings (key, value) VALUES ('seed_version', $1)", [String(SEED_VERSION)]);

  console.log('Database seeded successfully at version', SEED_VERSION);
}

// API Routes

// GET /api/summary
app.get('/api/summary', async (req, res) => {
  try {
    const totalVisitors = await db.query('SELECT COALESCE(SUM(visitors), 0) AS total FROM daily_metrics');
    const totalRevenue = await db.query('SELECT COALESCE(SUM(revenue), 0) AS total FROM daily_metrics');
    const bestDay = await db.query('SELECT date, revenue FROM daily_metrics ORDER BY revenue DESC LIMIT 1');

    // 7-day trend: compare last 7 days to previous 7 days
    const last7 = await db.query(`
      SELECT COALESCE(SUM(revenue), 0) AS total FROM daily_metrics
      WHERE date >= (SELECT MAX(date) - INTERVAL '6 days' FROM daily_metrics)
    `);
    const prev7 = await db.query(`
      SELECT COALESCE(SUM(revenue), 0) AS total FROM daily_metrics
      WHERE date >= (SELECT MAX(date) - INTERVAL '13 days' FROM daily_metrics)
        AND date < (SELECT MAX(date) - INTERVAL '6 days' FROM daily_metrics)
    `);

    const last7Val = parseFloat(last7.rows[0].total);
    const prev7Val = parseFloat(prev7.rows[0].total);
    const trend = prev7Val > 0 ? ((last7Val - prev7Val) / prev7Val * 100) : 0;

    let bestDayData = null;
    if (bestDay.rows[0]) {
      const bdDate = bestDay.rows[0].date;
      // Ensure date is a string in YYYY-MM-DD format
      const dateStr = bdDate instanceof Date ? bdDate.toISOString().split('T')[0] : String(bdDate).split('T')[0];
      bestDayData = { date: dateStr, revenue: parseFloat(bestDay.rows[0].revenue) };
    }

    res.json({
      totalVisitors: parseInt(totalVisitors.rows[0].total),
      totalRevenue: parseFloat(totalRevenue.rows[0].total),
      bestDay: bestDayData,
      trendPercent: Math.round(trend * 100) / 100
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

// GET /api/timeseries
app.get('/api/timeseries', async (req, res) => {
  try {
    const result = await db.query('SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC');
    const rows = result.rows.map(r => ({
      date: r.date instanceof Date ? r.date.toISOString().split('T')[0] : String(r.date).split('T')[0],
      visitors: r.visitors,
      revenue: parseFloat(r.revenue)
    }));
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch timeseries' });
  }
});

// GET /api/categories
app.get('/api/categories', async (req, res) => {
  try {
    const result = await db.query('SELECT name, value FROM categories ORDER BY value DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// GET /api/recent
app.get('/api/recent', async (req, res) => {
  try {
    const result = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC');
    res.json(result.rows.map(r => ({
      ...r,
      value: parseFloat(r.value)
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch recent items' });
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
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// PUT /api/settings
app.put('/api/settings', async (req, res) => {
  try {
    const { theme } = req.body;
    if (!theme || !['light', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'Invalid theme. Must be "light" or "dark".' });
    }
    await db.query("UPDATE settings SET value = $1 WHERE key = 'theme'", [theme]);
    res.json({ theme });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

const PORT = process.env.PORT || 3001;

initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
