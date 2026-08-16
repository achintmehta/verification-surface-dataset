const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const DB_PATH = path.join(__dirname, '..', 'pgdata');

let db;

// Deterministic seed helper using a simple PRNG (mulberry32)
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

  // Create schema
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      visitors INTEGER NOT NULL,
      revenue REAL NOT NULL
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
      value REAL NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*) AS cnt FROM daily_metrics');
  if (parseInt(countResult.rows[0].cnt) > 0) {
    console.log('Database already seeded.');
    return;
  }

  console.log('Seeding data...');

  // Seed with deterministic data
  const rng = mulberry32(42);

  // Seed daily_metrics: 30 days starting from 2024-01-01
  for (let i = 0; i < 30; i++) {
    const d = new Date(2024, 0, 1 + i); // January 1 + i
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;
    const visitors = Math.floor(rng() * 4000) + 500;
    const revenue = Math.round((rng() * 500 + 100) * 100) / 100;
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, visitors, revenue]
    );
  }

  // Seed categories: 6 categories, one with a long name, one value >= 1,000,000
  const categories = [
    { name: 'Electronics', value: Math.floor(rng() * 500000) + 200000 },
    { name: 'Enterprise Infrastructure & Compliance', value: Math.floor(rng() * 300000) + 100000 },
    { name: 'Fashion', value: Math.floor(rng() * 400000) + 150000 },
    { name: 'Home & Garden', value: 1250000 + Math.floor(rng() * 100000) },
    { name: 'Books', value: Math.floor(rng() * 200000) + 50000 },
    { name: 'Sports', value: Math.floor(rng() * 350000) + 100000 }
  ];

  for (const cat of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [cat.name, cat.value]
    );
  }

  // Seed recent_items: 20 items
  const itemNames = [
    'Widget Pro', 'DataSync Module', 'CloudBridge Kit', 'NetGuard Suite',
    'PixelForge Tool', 'StreamLine Hub', 'DevOps Monitor', 'AI Classifier',
    'Smart Thermostat', 'Edge Compute Node', 'API Gateway Pro', 'Log Analyzer',
    'Cache Manager', 'Load Balancer X', 'Backup Solution', 'Migration Tool',
    'Compliance Engine', 'Analytics Pack', 'Security Scanner', 'Report Builder'
  ];

  const catNames = categories.map(c => c.name);

  for (let i = 0; i < 20; i++) {
    const catIndex = Math.floor(rng() * catNames.length);
    const value = Math.round((rng() * 1000 + 10) * 100) / 100;
    const hoursAgo = Math.floor(rng() * 120);
    const createdAt = new Date(2024, 0, 25);
    createdAt.setHours(createdAt.getHours() - hoursAgo);

    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [itemNames[i], catNames[catIndex], value, createdAt.toISOString()]
    );
  }

  // Seed settings
  await db.query("INSERT INTO settings (key, value) VALUES ('theme', 'light')");

  console.log('Database seeded successfully.');
}

// API Routes

// GET /api/summary
app.get('/api/summary', async (req, res) => {
  try {
    const totalVisitorsResult = await db.query('SELECT SUM(visitors) AS total FROM daily_metrics');
    const totalRevenueResult = await db.query('SELECT SUM(revenue) AS total FROM daily_metrics');
    const bestDayResult = await db.query('SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1');

    // 7-day trend: compare last 7 days avg to previous 7 days avg
    const allSorted = await db.query('SELECT visitors FROM daily_metrics ORDER BY date DESC');
    const rows = allSorted.rows;

    let last7Avg = 0, prev7Avg = 0;
    if (rows.length >= 14) {
      const last7Sum = rows.slice(0, 7).reduce((s, r) => s + Number(r.visitors), 0);
      const prev7Sum = rows.slice(7, 14).reduce((s, r) => s + Number(r.visitors), 0);
      last7Avg = last7Sum / 7;
      prev7Avg = prev7Sum / 7;
    } else if (rows.length >= 7) {
      const last7Sum = rows.slice(0, 7).reduce((s, r) => s + Number(r.visitors), 0);
      const remaining = rows.slice(7);
      const prevSum = remaining.reduce((s, r) => s + Number(r.visitors), 0);
      last7Avg = last7Sum / 7;
      prev7Avg = remaining.length > 0 ? prevSum / remaining.length : last7Avg;
    }

    const trendPct = prev7Avg === 0 ? 0 : ((last7Avg - prev7Avg) / prev7Avg * 100);

    const totalVisitors = Number(totalVisitorsResult.rows[0].total);
    const totalRevenue = Math.round(Number(totalRevenueResult.rows[0].total) * 100) / 100;

    res.json({
      totalVisitors,
      totalRevenue,
      bestDay: {
        date: bestDayResult.rows[0].date,
        visitors: Number(bestDayResult.rows[0].visitors)
      },
      trendPct: Math.round(trendPct * 10) / 10
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
    const rows = result.rows.map(r => ({
      date: r.date,
      visitors: Number(r.visitors),
      revenue: Number(r.revenue)
    }));
    res.json(rows);
  } catch (err) {
    console.error('Error in /api/timeseries:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/categories
app.get('/api/categories', async (req, res) => {
  try {
    const result = await db.query('SELECT name, value FROM categories ORDER BY value DESC');
    const rows = result.rows.map(r => ({
      name: r.name,
      value: Number(r.value)
    }));
    res.json(rows);
  } catch (err) {
    console.error('Error in /api/categories:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/recent
app.get('/api/recent', async (req, res) => {
  try {
    const result = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC');
    const rows = result.rows.map(r => ({
      name: r.name,
      category: r.category,
      value: Number(r.value),
      created_at: r.created_at
    }));
    res.json(rows);
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

    const existing = await db.query("SELECT key FROM settings WHERE key = 'theme'");
    if (existing.rows.length > 0) {
      await db.query("UPDATE settings SET value = $1 WHERE key = 'theme'", [theme]);
    } else {
      await db.query("INSERT INTO settings (key, value) VALUES ('theme', $1)", [theme]);
    }

    res.json({ theme });
  } catch (err) {
    console.error('Error in PUT /api/settings:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
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
