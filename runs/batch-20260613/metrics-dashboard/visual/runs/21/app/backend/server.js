const express = require('express');
const cors = require('cors');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
app.use(cors());
app.use(express.json());

// Serve frontend static files from dist if available
app.use(express.static(path.join(__dirname, '..', 'frontend')));

const DB_PATH = path.join(__dirname, '..', 'pgdata');

let db;

// Deterministic seeded random number generator (mulberry32)
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
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
  const countResult = await db.query('SELECT COUNT(*) as cnt FROM daily_metrics');
  const count = parseInt(countResult.rows[0].cnt, 10);

  if (count === 0) {
    await seed();
  }
}

async function seed() {
  const rng = mulberry32(42);

  // Seed 30 days of daily_metrics
  const baseDate = new Date('2024-11-01');
  for (let i = 0; i < 30; i++) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const visitors = Math.floor(rng() * 4000) + 500;
    const revenue = Math.floor(rng() * 50000 + 1000) / 100 * 100; // round to nearest 100
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, visitors, Math.round(revenue * 100) / 100]
    );
  }

  // Seed 6 categories - one has a deliberately long name, one has value >= 1,000,000
  const categories = [
    { name: 'Electronics', value: 245000 },
    { name: 'Clothing', value: 189000 },
    { name: 'Enterprise Infrastructure & Compliance', value: 1250000 },
    { name: 'Home & Garden', value: 167000 },
    { name: 'Sports', value: 98000 },
    { name: 'Books', value: 72000 },
  ];

  for (const cat of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [cat.name, cat.value]
    );
  }

  // Seed 20 recent items
  const itemNames = [
    'Server Rack A', 'Wireless Router', 'Cloud License', 'Firewall Module',
    'SSD Storage Unit', 'RAM Kit 64GB', 'Monitor 27"', 'Keyboard Pro',
    'Mouse Ergonomic', 'USB Hub', 'Ethernet Cable 50ft', 'Power Supply 750W',
    'GPU Accelerator', 'CPU Cooler', 'Laptop Stand', 'Webcam HD',
    'Headset Wireless', 'Docking Station', 'Surge Protector', 'Cable Manager'
  ];
  const itemCategories = ['Electronics', 'Clothing', 'Enterprise Infrastructure & Compliance', 'Home & Garden', 'Sports', 'Books'];

  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = itemCategories[Math.floor(rng() * itemCategories.length)];
    const value = Math.floor(rng() * 100000) / 100 + 10;
    const daysAgo = Math.floor(rng() * 30);
    const createdAt = new Date(baseDate);
    createdAt.setDate(createdAt.getDate() + 30 - daysAgo);
    createdAt.setHours(Math.floor(rng() * 24), Math.floor(rng() * 60));

    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, Math.round(value * 100) / 100, createdAt.toISOString()]
    );
  }

  // Default setting
  await db.query(
    "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING"
  );

  console.log('Database seeded successfully.');
}

// --- API Routes ---

// GET /api/summary
app.get('/api/summary', async (req, res) => {
  try {
    const totalVisitors = await db.query('SELECT COALESCE(SUM(visitors), 0) as total FROM daily_metrics');
    const totalRevenue = await db.query('SELECT COALESCE(SUM(revenue), 0) as total FROM daily_metrics');
    const bestDay = await db.query('SELECT date, revenue FROM daily_metrics ORDER BY revenue DESC LIMIT 1');

    // 7-day trend: compare last 7 days to previous 7 days
    const last7 = await db.query(`
      SELECT COALESCE(SUM(visitors), 0) as total
      FROM daily_metrics
      WHERE date > (SELECT MAX(date) - INTERVAL '7 days' FROM daily_metrics)
    `);
    const prev7 = await db.query(`
      SELECT COALESCE(SUM(visitors), 0) as total
      FROM daily_metrics
      WHERE date <= (SELECT MAX(date) - INTERVAL '7 days' FROM daily_metrics)
        AND date > (SELECT MAX(date) - INTERVAL '14 days' FROM daily_metrics)
    `);

    const last7Val = parseFloat(last7.rows[0].total) || 0;
    const prev7Val = parseFloat(prev7.rows[0].total) || 1;
    const trend = ((last7Val - prev7Val) / prev7Val * 100).toFixed(1);

    res.json({
      totalVisitors: parseInt(totalVisitors.rows[0].total, 10),
      totalRevenue: parseFloat(totalRevenue.rows[0].total),
      bestDay: bestDay.rows[0] ? { date: bestDay.rows[0].date, revenue: parseFloat(bestDay.rows[0].revenue) } : null,
      sevenDayTrend: parseFloat(trend)
    });
  } catch (err) {
    console.error('Error in /api/summary:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/timeseries
app.get('/api/timeseries', async (req, res) => {
  try {
    const result = await db.query('SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC');
    res.json(result.rows.map(r => ({
      date: r.date,
      visitors: parseInt(r.visitors, 10),
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
    const result = await db.query('SELECT name, value FROM categories ORDER BY value DESC');
    res.json(result.rows.map(r => ({
      name: r.name,
      value: parseInt(r.value, 10)
    })));
  } catch (err) {
    console.error('Error in /api/categories:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/recent
app.get('/api/recent', async (req, res) => {
  try {
    const result = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC');
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

// Fallback: serve index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

const PORT = process.env.PORT || 3001;

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
