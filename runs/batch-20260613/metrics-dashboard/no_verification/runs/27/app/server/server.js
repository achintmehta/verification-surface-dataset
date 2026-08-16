import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const DATA_DIR = path.join(__dirname, '.pglite');
const DB_PATH = path.join(DATA_DIR, 'metrics.db');

let db;

async function initDb() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  db = new PGlite({ dataDir: DATA_DIR });

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
}

async function seedData() {
  console.log('Seeding deterministic data...');

  // 30 days of metrics, starting from 30 days ago
  const baseDate = new Date('2024-01-01');
  const visitorsBase = 1200;
  const revenueBase = 45000;

  for (let i = 0; i < 30; i++) {
    const date = new Date(baseDate);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];
    
    // Deterministic variation
    const visitors = visitorsBase + Math.floor(Math.sin(i / 5) * 300) + (i % 7) * 50;
    const revenue = revenueBase + Math.floor(Math.cos(i / 4) * 15000) + (i % 5) * 2000;
    
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, Math.max(800, visitors), Math.max(30000, revenue)]
    );
  }

  // 6 categories, one with long name, one with large value
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

  // 20 recent items
  const itemNames = [
    'Acme Corp - Q4 License', 'Beta Inc - Migration', 'Gamma LLC - Support',
    'Delta Systems - Hardware', 'Epsilon Ltd - Training', 'Zeta Co - Renewal',
    'Eta Partners - Consulting', 'Theta Inc - Upgrade', 'Iota Labs - Setup',
    'Kappa Group - Audit', 'Lambda Tech - Integration', 'Mu Solutions - Custom',
    'Nu Corp - Expansion', 'Xi Systems - Maintenance', 'Omicron Ltd - License',
    'Pi Partners - Workshop', 'Rho Inc - Migration', 'Sigma LLC - Support',
    'Tau Co - Hardware', 'Upsilon - Training'
  ];

  const itemCategories = ['Enterprise', 'SaaS', 'Services', 'Hardware', 'Training', 'Support'];

  for (let i = 0; i < 20; i++) {
    const date = new Date('2024-01-25');
    date.setDate(date.getDate() - (i % 10));
    const value = 15000 + (i * 1234) % 85000;
    
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [itemNames[i], itemCategories[i % itemCategories.length], value, date.toISOString()]
    );
  }

  // Default settings
  await db.query(
    "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING"
  );

  console.log('Seeding complete.');
}

async function getSummary() {
  const { rows: visitorsRows } = await db.query('SELECT SUM(visitors) as total FROM daily_metrics');
  const totalVisitors = parseInt(visitorsRows[0].total) || 0;

  const { rows: revenueRows } = await db.query('SELECT SUM(revenue) as total FROM daily_metrics');
  const totalRevenue = parseInt(revenueRows[0].total) || 0;

  const { rows: bestDayRows } = await db.query(
    'SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1'
  );
  const bestDay = bestDayRows[0] ? bestDayRows[0].date : null;

  // 7-day trend: compare last 7 days to previous 7
  const { rows: recent } = await db.query(
    'SELECT SUM(visitors) as sum FROM daily_metrics ORDER BY date DESC LIMIT 7'
  );
  const { rows: previous } = await db.query(
    'SELECT SUM(visitors) as sum FROM daily_metrics ORDER BY date DESC LIMIT 14 OFFSET 7'
  );
  const recentSum = parseInt(recent[0]?.sum) || 0;
  const prevSum = parseInt(previous[0]?.sum) || 1;
  const trend = Math.round(((recentSum - prevSum) / prevSum) * 100);

  return {
    totalVisitors,
    totalRevenue,
    bestDay,
    sevenDayTrend: trend
  };
}

app.get('/api/summary', async (req, res) => {
  try {
    const summary = await getSummary();
    res.json(summary);
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
    const theme = rows[0]?.value || 'light';
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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);