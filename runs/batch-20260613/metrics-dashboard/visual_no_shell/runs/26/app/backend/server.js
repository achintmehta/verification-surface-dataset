const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

let db;
let dbInitialized = false;

async function initDB() {
  if (dbInitialized) return;
  
  db = new PGlite('./metrics.db');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue INTEGER NOT NULL
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
      value INTEGER NOT NULL,
      created_at TIMESTAMP NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Check if seeded
  const { rows: metricCount } = await db.query('SELECT COUNT(*) as count FROM daily_metrics');
  if (parseInt(metricCount[0].count) === 0) {
    await seedData();
  }
  
  dbInitialized = true;
}

async function seedData() {
  console.log('Seeding deterministic data...');
  
  // Seed 30 days of metrics (deterministic)
  const baseDate = new Date('2025-01-01');
  for (let i = 0; i < 30; i++) {
    const date = new Date(baseDate);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];
    
    // Deterministic values based on day index
    const visitors = 1200 + Math.floor(Math.sin(i / 4) * 400) + (i * 7) % 180;
    const revenue = 4500 + Math.floor(Math.cos(i / 3) * 1200) + (i * 13) % 600;
    
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, visitors, revenue]
    );
  }

  // Seed 6 categories (one long name, one high value)
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1240000 },
    { name: 'SaaS Subscriptions', value: 875000 },
    { name: 'Professional Services', value: 492000 },
    { name: 'Hardware & Devices', value: 318500 },
    { name: 'Training & Education', value: 156200 },
    { name: 'Support & Maintenance', value: 98000 }
  ];
  
  for (const cat of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [cat.name, cat.value]
    );
  }

  // Seed 20 recent items
  const itemNames = [
    'Acme Corp Platform License', 'Globex Analytics Suite', 'Stark Industries Support',
    'Wayne Enterprises Training', 'Oscorp Compliance Audit', 'LexCorp SaaS Renewal',
    'Daily Planet Hardware Bundle', 'Queen Industries Consulting', 'Kryptonite Monitoring',
    'Shield Security Package', 'Avengers Cloud Migration', 'Hydra Data Pipeline',
    'S.H.I.E.L.D. Dashboard Pro', 'X-Men Performance Review', 'Fantastic Four Integration',
    'Spider-Man Mobile App', 'Iron Man Analytics', 'Captain America Report',
    'Black Widow Security Audit', 'Hulk Storage Expansion'
  ];
  
  const itemCategories = ['Enterprise', 'SaaS', 'Services', 'Hardware', 'Training', 'Support'];
  
  for (let i = 0; i < 20; i++) {
    const date = new Date(baseDate);
    date.setDate(date.getDate() + 29 - Math.floor(i / 2));
    const name = itemNames[i % itemNames.length];
    const cat = itemCategories[i % itemCategories.length];
    const value = 15000 + (i * 137) % 85000;
    
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, cat, value, date.toISOString()]
    );
  }

  // Default settings
  await db.query(
    "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT DO NOTHING"
  );
  
  console.log('Seeding complete.');
}

async function getSummary() {
  const { rows: visitorsRows } = await db.query('SELECT SUM(visitors) as total FROM daily_metrics');
  const totalVisitors = parseInt(visitorsRows[0].total) || 0;

  const { rows: revenueRows } = await db.query('SELECT SUM(revenue) as total FROM daily_metrics');
  const totalRevenue = parseInt(revenueRows[0].total) || 0;

  const { rows: bestDayRows } = await db.query(
    'SELECT date, revenue FROM daily_metrics ORDER BY revenue DESC LIMIT 1'
  );
  const bestDay = bestDayRows[0] ? new Date(bestDayRows[0].date).toISOString().split('T')[0] : 'N/A';
  const bestDayValue = bestDayRows[0] ? parseInt(bestDayRows[0].revenue) : 0;

  // 7-day trend
  const { rows: recentRows } = await db.query(
    'SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 14'
  );
  let trend7d = 0;
  if (recentRows.length >= 14) {
    const last7 = recentRows.slice(0, 7).reduce((a, b) => a + parseInt(b.visitors), 0);
    const prev7 = recentRows.slice(7, 14).reduce((a, b) => a + parseInt(b.visitors), 0);
    if (prev7 > 0) {
      trend7d = Math.round(((last7 - prev7) / prev7) * 100);
    }
  }

  return { totalVisitors, totalRevenue, bestDay, bestDayValue, trend7d };
}

app.get('/api/summary', async (req, res) => {
  try {
    await initDB();
    const summary = await getSummary();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/timeseries', async (req, res) => {
  try {
    await initDB();
    const { rows } = await db.query(
      'SELECT date, visitors FROM daily_metrics ORDER BY date ASC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    await initDB();
    const { rows } = await db.query(
      'SELECT name, value FROM categories ORDER BY value DESC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/recent', async (req, res) => {
  try {
    await initDB();
    const { rows } = await db.query(
      'SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    await initDB();
    const { rows } = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    const theme = rows[0] ? rows[0].value : 'light';
    res.json({ theme });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    await initDB();
    const { theme } = req.body;
    if (!['light', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'Invalid theme' });
    }
    await db.query(
      "INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [theme]
    );
    res.json({ success: true, theme });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
  await initDB();
});