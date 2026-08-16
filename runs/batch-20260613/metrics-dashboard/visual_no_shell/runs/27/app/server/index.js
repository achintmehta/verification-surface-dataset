import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// PGLite data directory for persistence
const dataDir = path.join(__dirname, 'pglite-data');

let db;

async function initDb() {
  db = new PGlite({ dataDir });

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
  const { rows: seedCheck } = await db.query('SELECT COUNT(*) as count FROM daily_metrics');
  if (parseInt(seedCheck[0].count) === 0) {
    await seedDatabase();
  }
}

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

async function seedDatabase() {
  const rand = seededRandom(42); // fixed seed

  // Seed 30 days of daily_metrics
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    const visitors = Math.floor(800 + rand() * 1200);
    const revenue = Math.floor(5000 + rand() * 15000);
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, visitors, revenue]
    );
  }

  // Seed 6 categories, one with long name, one with high value
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 2450000 },
    { name: 'SaaS Subscriptions', value: 1890000 },
    { name: 'Professional Services', value: 920000 },
    { name: 'Hardware Sales', value: 675000 },
    { name: 'Training & Education', value: 340000 },
    { name: 'Support Contracts', value: 285000 }
  ];
  for (const cat of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [cat.name, cat.value]
    );
  }

  // Seed 20 recent items
  const itemNames = [
    'Acme Corp License Renewal', 'BetaTech Platform Upgrade', 'Gamma Solutions Onboarding',
    'Delta Systems Audit', 'Epsilon Cloud Migration', 'Zeta Analytics Setup',
    'Eta Security Review', 'Theta Data Integration', 'Iota API Development',
    'Kappa Mobile App Launch', 'Lambda Infrastructure Audit', 'Mu Compliance Training',
    'Nu Performance Tuning', 'Xi Support Package', 'Omicron Hardware Bundle',
    'Pi Consulting Hours', 'Rho Subscription Renewal', 'Sigma Workshop Series',
    'Tau Custom Development', 'Upsilon Monitoring Service'
  ];
  const itemCategories = ['Enterprise', 'SaaS', 'Services', 'Hardware', 'Training', 'Support'];
  for (let i = 0; i < 20; i++) {
    const name = itemNames[i % itemNames.length];
    const category = itemCategories[i % itemCategories.length];
    const value = Math.floor(15000 + rand() * 85000);
    const created = new Date(today);
    created.setDate(created.getDate() - Math.floor(rand() * 14));
    const createdStr = created.toISOString();
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, createdStr]
    );
  }

  // Default settings
  await db.query(
    "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING"
  );
}

app.use(cors());
app.use(express.json());

// API Routes
app.get('/api/summary', async (req, res) => {
  try {
    const { rows: visitorsRows } = await db.query('SELECT SUM(visitors) as total_visitors FROM daily_metrics');
    const { rows: revenueRows } = await db.query('SELECT SUM(revenue) as total_revenue FROM daily_metrics');
    const { rows: bestDayRows } = await db.query('SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1');
    const { rows: trendRows } = await db.query(`
      SELECT 
        (SELECT SUM(visitors) FROM daily_metrics WHERE date >= CURRENT_DATE - INTERVAL '7 days') as last_7,
        (SELECT SUM(visitors) FROM daily_metrics WHERE date >= CURRENT_DATE - INTERVAL '14 days' AND date < CURRENT_DATE - INTERVAL '7 days') as prev_7
    `);

    const totalVisitors = parseInt(visitorsRows[0].total_visitors) || 0;
    const totalRevenue = parseInt(revenueRows[0].total_revenue) || 0;
    const bestDay = bestDayRows[0] ? bestDayRows[0].date : null;
    const bestDayVisitors = bestDayRows[0] ? bestDayRows[0].visitors : 0;

    const last7 = parseInt(trendRows[0].last_7) || 0;
    const prev7 = parseInt(trendRows[0].prev_7) || 1;
    const trend = prev7 > 0 ? Math.round(((last7 - prev7) / prev7) * 100) : 0;

    res.json({
      totalVisitors,
      totalRevenue,
      bestDay,
      bestDayVisitors,
      sevenDayTrend: trend
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/timeseries', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC'
    );
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
    const { rows } = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    const theme = rows.length > 0 ? rows[0].value : 'light';
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

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);