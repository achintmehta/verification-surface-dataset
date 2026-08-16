const express = require('express');
const cors = require('cors');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '..', 'public')));

let db;

// Deterministic seed random number generator (mulberry32)
function mulberry32(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

async function initDB() {
  db = new PGlite(path.join(__dirname, '..', 'pgdata'));

  // Check if already seeded
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue NUMERIC(12,2) NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      value INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(255) NOT NULL,
      value NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMP NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key VARCHAR(64) PRIMARY KEY,
      value VARCHAR(255) NOT NULL
    );
  `);

  const check = await db.query("SELECT COUNT(*) as cnt FROM daily_metrics");
  const count = parseInt(check.rows[0].cnt, 10);

  if (count === 0) {
    await seedData();
  }
}

async function seedData() {
  const rng = mulberry32(42);

  // Seed 30 days of daily_metrics
  const baseDate = new Date('2025-01-01');
  for (let i = 0; i < 30; i++) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const visitors = Math.floor(rng() * 5000) + 500;
    const revenue = (rng() * 50000 + 1000).toFixed(2);
    await db.query(
      "INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)",
      [dateStr, visitors, revenue]
    );
  }

  // Seed 6 categories (one long label, one value >= 1,000,000)
  const categoryNames = [
    'Sales',
    'Marketing',
    'Engineering',
    'Enterprise Infrastructure & Compliance',
    'Support',
    'Operations'
  ];
  const categoryValues = [
    Math.floor(rng() * 500000) + 100000,
    Math.floor(rng() * 300000) + 50000,
    Math.floor(rng() * 400000) + 200000,
    1250000 + Math.floor(rng() * 100000),  // >= 1,000,000
    Math.floor(rng() * 200000) + 30000,
    Math.floor(rng() * 350000) + 80000
  ];
  for (let i = 0; i < categoryNames.length; i++) {
    await db.query(
      "INSERT INTO categories (name, value) VALUES ($1, $2)",
      [categoryNames[i], categoryValues[i]]
    );
  }

  // Seed 20 recent items
  const itemCategories = ['Sales', 'Marketing', 'Engineering', 'Support', 'Operations'];
  for (let i = 0; i < 20; i++) {
    const name = `Item ${String(i + 1).padStart(3, '0')}`;
    const cat = itemCategories[Math.floor(rng() * itemCategories.length)];
    const value = (rng() * 10000 + 100).toFixed(2);
    const createdAt = new Date(baseDate);
    createdAt.setDate(createdAt.getDate() + Math.floor(rng() * 30));
    createdAt.setHours(Math.floor(rng() * 24), Math.floor(rng() * 60));
    await db.query(
      "INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)",
      [name, cat, value, createdAt.toISOString()]
    );
  }

  // Seed default theme
  await db.query(
    "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING"
  );

  console.log('Database seeded successfully.');
}

// --- API Routes ---

// GET /api/summary
app.get('/api/summary', async (req, res) => {
  try {
    const totalVisitors = await db.query("SELECT COALESCE(SUM(visitors), 0) as total FROM daily_metrics");
    const totalRevenue = await db.query("SELECT COALESCE(SUM(revenue), 0) as total FROM daily_metrics");
    const bestDay = await db.query("SELECT date, revenue FROM daily_metrics ORDER BY revenue DESC LIMIT 1");

    // 7-day trend: compare last 7 days to previous 7 days
    const allRows = await db.query("SELECT date, visitors FROM daily_metrics ORDER BY date ASC");
    const rows = allRows.rows;
    let trend = 0;
    if (rows.length >= 14) {
      const recent7 = rows.slice(-7).reduce((s, r) => s + parseInt(r.visitors), 0);
      const prev7 = rows.slice(-14, -7).reduce((s, r) => s + parseInt(r.visitors), 0);
      if (prev7 > 0) {
        trend = ((recent7 - prev7) / prev7 * 100);
      }
    }

    res.json({
      totalVisitors: parseInt(totalVisitors.rows[0].total),
      totalRevenue: parseFloat(totalRevenue.rows[0].total),
      bestDay: bestDay.rows[0] ? { date: bestDay.rows[0].date, revenue: parseFloat(bestDay.rows[0].revenue) } : null,
      trend: Math.round(trend * 100) / 100
    });
  } catch (err) {
    console.error('Error in /api/summary:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/timeseries
app.get('/api/timeseries', async (req, res) => {
  try {
    const result = await db.query("SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC");
    res.json(result.rows.map(r => ({
      date: r.date,
      visitors: parseInt(r.visitors),
      revenue: parseFloat(r.revenue)
    })));
  } catch (err) {
    console.error('Error in /api/timeseries:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/categories
app.get('/api/categories', async (req, res) => {
  try {
    const result = await db.query("SELECT name, value FROM categories ORDER BY value DESC");
    res.json(result.rows.map(r => ({ name: r.name, value: parseInt(r.value) })));
  } catch (err) {
    console.error('Error in /api/categories:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/recent
app.get('/api/recent', async (req, res) => {
  try {
    const result = await db.query("SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC");
    res.json(result.rows.map(r => ({
      name: r.name,
      category: r.category,
      value: parseFloat(r.value),
      createdAt: r.created_at
    })));
  } catch (err) {
    console.error('Error in /api/recent:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/settings
app.get('/api/settings', async (req, res) => {
  try {
    const result = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    const theme = result.rows.length > 0 ? result.rows[0].value : 'light';
    res.json({ theme });
  } catch (err) {
    console.error('Error in GET /api/settings:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/settings
app.put('/api/settings', async (req, res) => {
  try {
    const { theme } = req.body;
    if (!theme || !['light', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'Invalid theme. Must be "light" or "dark".' });
    }
    await db.query(
      "INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [theme]
    );
    res.json({ theme });
  } catch (err) {
    console.error('Error in PUT /api/settings:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Catch-all: serve index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await initDB();
    app.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
