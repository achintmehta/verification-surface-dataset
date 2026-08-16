import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// PGLite setup with filesystem persistence
const dbPath = path.join(__dirname, 'data');
if (!fs.existsSync(dbPath)) {
  fs.mkdirSync(dbPath, { recursive: true });
}

let db;

async function initDb() {
  db = new PGlite(`file://${dbPath}`);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue DECIMAL(10,2) NOT NULL
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
      value DECIMAL(10,2) NOT NULL,
      created_at TIMESTAMP NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Check if seeded
  const { rows } = await db.query('SELECT COUNT(*) as count FROM daily_metrics');
  if (parseInt(rows[0].count) === 0) {
    await seedDatabase();
  }
}

function seededRandom(seed) {
  let x = seed;
  return function() {
    x = (x * 16807) % 2147483647;
    return (x - 1) / 2147483646;
  };
}

async function seedDatabase() {
  const rand = seededRandom(42); // fixed seed

  // Seed daily_metrics: 30 days
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    const visitors = Math.floor(1000 + rand() * 4000);
    const revenue = (5000 + rand() * 15000).toFixed(2);
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, visitors, revenue]
    );
  }

  // Seed categories: 6 rows, one long name, one >=1M
  const categories = [
    { name: 'Direct', value: 1250000 },
    { name: 'Organic Search', value: 890000 },
    { name: 'Paid Search', value: 450000 },
    { name: 'Social Media', value: 320000 },
    { name: 'Referral', value: 210000 },
    { name: 'Enterprise Infrastructure & Compliance', value: 1500000 }
  ];
  for (const cat of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [cat.name, cat.value]
    );
  }

  // Seed recent_items: 20 rows
  const itemNames = ['Acme Corp', 'Beta Inc', 'Gamma LLC', 'Delta Co', 'Epsilon Ltd', 'Zeta SA', 'Eta GmbH', 'Theta Inc', 'Iota Corp', 'Kappa LLC'];
  const itemCategories = ['Direct', 'Organic Search', 'Paid Search', 'Social Media', 'Referral', 'Enterprise'];
  for (let i = 0; i < 20; i++) {
    const name = itemNames[i % itemNames.length] + (i > 9 ? ` ${Math.floor(i/10)}` : '');
    const category = itemCategories[Math.floor(rand() * itemCategories.length)];
    const value = (100 + rand() * 9900).toFixed(2);
    const created = new Date(today.getTime() - Math.floor(rand() * 30) * 86400000).toISOString();
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, created]
    );
  }

  // Default settings
  await db.query(
    "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT DO NOTHING"
  );
}

app.get('/api/summary', async (req, res) => {
  try {
    const visitorsRes = await db.query('SELECT SUM(visitors) as total FROM daily_metrics');
    const totalVisitors = parseInt(visitorsRes.rows[0].total) || 0;

    const revenueRes = await db.query('SELECT SUM(revenue) as total FROM daily_metrics');
    const totalRevenue = parseFloat(revenueRes.rows[0].total || 0).toFixed(2);

    const bestDayRes = await db.query('SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1');
    const bestDay = bestDayRes.rows[0] ? bestDayRes.rows[0].date : null;

    // 7-day trend
    const trendRes = await db.query(`
      SELECT 
        (SELECT SUM(visitors) FROM daily_metrics WHERE date >= CURRENT_DATE - INTERVAL '7 days') as recent,
        (SELECT SUM(visitors) FROM daily_metrics WHERE date >= CURRENT_DATE - INTERVAL '14 days' AND date < CURRENT_DATE - INTERVAL '7 days') as previous
    `);
    const recent = parseInt(trendRes.rows[0].recent) || 0;
    const previous = parseInt(trendRes.rows[0].previous) || 1;
    const trend = previous > 0 ? ((recent - previous) / previous * 100).toFixed(1) : '0.0';

    res.json({
      totalVisitors,
      totalRevenue,
      bestDay,
      sevenDayTrend: parseFloat(trend)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/timeseries', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT date, visitors, revenue FROM daily_metrics ORDER BY date');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT name, value FROM categories ORDER BY value DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/recent', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const { rows } = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    const theme = rows[0] ? rows[0].value : 'light';
    res.json({ theme });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const { theme } = req.body;
    if (!['light', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'Invalid theme' });
    }
    await db.query(
      "INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [theme]
    );
    res.json({ theme });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);