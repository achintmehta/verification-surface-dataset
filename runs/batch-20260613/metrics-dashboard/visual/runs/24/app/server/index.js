const express = require('express');
const cors = require('cors');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static frontend build if it exists
app.use(express.static(path.join(__dirname, '..', 'frontend', 'dist')));

const PORT = process.env.PORT || 3001;
const DB_PATH = path.join(__dirname, '..', 'pgdata');

let db;

// Deterministic seeded random number generator (mulberry32)
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

async function initDB() {
  db = new PGlite(DB_PATH);

  // Check if already seeded
  const tableCheck = await db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables WHERE table_name = 'daily_metrics'
    ) AS exists
  `);

  if (tableCheck.rows[0].exists) {
    console.log('Database already seeded.');
    return;
  }

  console.log('Creating schema and seeding data...');

  // Create schema
  await db.query(`
    CREATE TABLE daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue NUMERIC(12,2) NOT NULL
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
      value NUMERIC(12,2) NOT NULL,
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
  const baseDate = new Date('2025-01-01');
  for (let i = 0; i < 30; i++) {
    const date = new Date(baseDate);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];
    const visitors = Math.floor(rng() * 5000) + 500;
    const revenue = (rng() * 50000 + 1000).toFixed(2);
    await db.query(
      `INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)`,
      [dateStr, visitors, revenue]
    );
  }

  // 6 categories (one long name, one value >= 1,000,000)
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1250000 },
    { name: 'Marketing', value: 450000 },
    { name: 'Sales', value: 780000 },
    { name: 'Engineering', value: 920000 },
    { name: 'Support', value: 310000 },
    { name: 'Analytics', value: 567000 }
  ];
  for (const cat of categories) {
    await db.query(
      `INSERT INTO categories (name, value) VALUES ($1, $2)`,
      [cat.name, cat.value]
    );
  }

  // 20 recent items
  const itemCategories = ['Sales', 'Marketing', 'Engineering', 'Support', 'Analytics', 'Enterprise Infrastructure & Compliance'];
  const itemNames = [
    'Widget Alpha', 'Service Beta', 'Platform Gamma', 'Tool Delta', 'Module Epsilon',
    'System Zeta', 'App Eta', 'Suite Theta', 'Engine Iota', 'Framework Kappa',
    'Library Lambda', 'Package Mu', 'Plugin Nu', 'Extension Xi', 'Addon Omicron',
    'Component Pi', 'Utility Rho', 'Helper Sigma', 'Wrapper Tau', 'Bridge Upsilon'
  ];
  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = itemCategories[Math.floor(rng() * itemCategories.length)];
    const value = (rng() * 100000 + 100).toFixed(2);
    const createdAt = new Date(baseDate);
    createdAt.setDate(createdAt.getDate() + Math.floor(rng() * 30));
    createdAt.setHours(Math.floor(rng() * 24), Math.floor(rng() * 60));
    await db.query(
      `INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)`,
      [name, category, value, createdAt.toISOString()]
    );
  }

  // Default settings
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('theme', 'light')`
  );

  console.log('Seed complete.');
}

// API Routes

// GET /api/summary - four headline numbers
app.get('/api/summary', async (req, res) => {
  try {
    const totalVisitors = await db.query(`SELECT SUM(visitors) AS total FROM daily_metrics`);
    const totalRevenue = await db.query(`SELECT SUM(revenue) AS total FROM daily_metrics`);
    const bestDay = await db.query(`SELECT date, revenue FROM daily_metrics ORDER BY revenue DESC LIMIT 1`);

    // 7-day trend: compare last 7 days avg vs previous 7 days avg
    const last7 = await db.query(`
      SELECT AVG(visitors) AS avg_visitors FROM (
        SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 7
      ) sub
    `);
    const prev7 = await db.query(`
      SELECT AVG(visitors) AS avg_visitors FROM (
        SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 7 OFFSET 7
      ) sub
    `);

    const last7Avg = parseFloat(last7.rows[0].avg_visitors) || 0;
    const prev7Avg = parseFloat(prev7.rows[0].avg_visitors) || 0;
    const trend = prev7Avg > 0 ? (((last7Avg - prev7Avg) / prev7Avg) * 100) : 0;

    res.json({
      totalVisitors: parseInt(totalVisitors.rows[0].total),
      totalRevenue: parseFloat(totalRevenue.rows[0].total),
      bestDay: {
        date: bestDay.rows[0].date,
        revenue: parseFloat(bestDay.rows[0].revenue)
      },
      sevenDayTrend: parseFloat(trend.toFixed(1))
    });
  } catch (err) {
    console.error('Error in /api/summary:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/timeseries
app.get('/api/timeseries', async (req, res) => {
  try {
    const result = await db.query(`SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC`);
    res.json(result.rows);
  } catch (err) {
    console.error('Error in /api/timeseries:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/categories
app.get('/api/categories', async (req, res) => {
  try {
    const result = await db.query(`SELECT name, value FROM categories ORDER BY value DESC`);
    res.json(result.rows);
  } catch (err) {
    console.error('Error in /api/categories:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/recent
app.get('/api/recent', async (req, res) => {
  try {
    const result = await db.query(`SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (err) {
    console.error('Error in /api/recent:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/settings
app.get('/api/settings', async (req, res) => {
  try {
    const result = await db.query(`SELECT value FROM settings WHERE key = 'theme'`);
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
    await db.query(`UPDATE settings SET value = $1 WHERE key = 'theme'`, [theme]);
    res.json({ theme });
  } catch (err) {
    console.error('Error in PUT /api/settings:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'dist', 'index.html'));
});

async function start() {
  await initDB();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
