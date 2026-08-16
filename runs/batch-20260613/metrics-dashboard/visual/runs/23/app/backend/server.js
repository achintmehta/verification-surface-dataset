const express = require('express');
const cors = require('cors');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
app.use(cors());
app.use(express.json());

// Serve built frontend static files
app.use(express.static(path.join(__dirname, '..', 'frontend', 'dist')));

const PORT = process.env.PORT || 3001;
const DB_PATH = path.join(__dirname, '..', 'pgdata');

let db;

// Simple seeded random number generator (mulberry32)
function seededRandom(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
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

  // Check if already seeded
  const check = await db.query('SELECT COUNT(*) as cnt FROM daily_metrics');
  const count = parseInt(check.rows[0].cnt, 10);

  if (count > 0) {
    console.log('Database already seeded.');
    return;
  }

  console.log('Seeding database...');
  const rand = seededRandom(42);

  // Seed daily_metrics: 30 days ending today (use fixed reference date for determinism)
  const baseDate = new Date('2025-01-15');
  for (let i = 29; i >= 0; i--) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const visitors = Math.floor(rand() * 4000) + 1000; // 1000-5000
    const revenue = Math.floor(rand() * 90000 + 10000) / 100; // 100.00 - 1000.00
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, visitors, revenue]
    );
  }

  // Seed categories: 6 rows, one with long label, one with value >= 1,000,000
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1250000 },
    { name: 'Cloud Services', value: 845000 },
    { name: 'Mobile Apps', value: 623000 },
    { name: 'Data Analytics', value: 512000 },
    { name: 'Security', value: 389000 },
    { name: 'Support', value: 275000 },
  ];
  for (const cat of categories) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [
      cat.name,
      cat.value,
    ]);
  }

  // Seed recent_items: 20 rows
  const itemNames = [
    'Widget Alpha', 'Widget Beta', 'Service Gamma', 'Platform Delta',
    'Module Epsilon', 'Tool Zeta', 'System Eta', 'App Theta',
    'Plugin Iota', 'Framework Kappa', 'Engine Lambda', 'Suite Mu',
    'Agent Nu', 'Gateway Xi', 'Hub Omicron', 'Connector Pi',
    'Relay Rho', 'Matrix Sigma', 'Nexus Tau', 'Core Upsilon',
  ];
  const catNames = categories.map((c) => c.name);
  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value = Math.floor(rand() * 99000 + 1000) / 100; // 10.00 - 1000.00
    const createdAt = new Date(baseDate);
    createdAt.setDate(createdAt.getDate() - Math.floor(rand() * 30));
    createdAt.setHours(Math.floor(rand() * 24), Math.floor(rand() * 60));
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, createdAt.toISOString()]
    );
  }

  // Seed default settings
  await db.query("INSERT INTO settings (key, value) VALUES ('theme', 'light')");

  console.log('Seeding complete.');
}

// API Routes

// GET /api/summary - four headline numbers
app.get('/api/summary', async (req, res) => {
  try {
    const totalVisitors = await db.query('SELECT SUM(visitors) as total FROM daily_metrics');
    const totalRevenue = await db.query('SELECT SUM(revenue) as total FROM daily_metrics');
    const bestDay = await db.query('SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1');

    // 7-day trend: compare last 7 days avg to previous 7 days avg
    const last7 = await db.query(`
      SELECT AVG(visitors) as avg_visitors FROM (
        SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 7
      ) sub
    `);
    const prev7 = await db.query(`
      SELECT AVG(visitors) as avg_visitors FROM (
        SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 7 OFFSET 7
      ) sub
    `);

    const last7Avg = parseFloat(last7.rows[0].avg_visitors) || 0;
    const prev7Avg = parseFloat(prev7.rows[0].avg_visitors) || 0;
    const trend = prev7Avg === 0 ? 0 : ((last7Avg - prev7Avg) / prev7Avg) * 100;

    res.json({
      totalVisitors: parseInt(totalVisitors.rows[0].total, 10),
      totalRevenue: parseFloat(parseFloat(totalRevenue.rows[0].total).toFixed(2)),
      bestDay: {
        date: bestDay.rows[0].date,
        visitors: parseInt(bestDay.rows[0].visitors, 10),
      },
      trend7d: Math.round(trend * 100) / 100,
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
    res.json(result.rows);
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
    res.json(result.rows);
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

// Fallback: serve index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'dist', 'index.html'));
});

async function start() {
  await initDB();
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
