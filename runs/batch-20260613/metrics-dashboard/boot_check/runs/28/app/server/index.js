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

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const dbPath = `file://${DATA_DIR}/metrics.db`;
let db;

async function initDb() {
  db = new PGlite(dbPath);
  await db.waitReady;

  // Create tables
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
  const metricsCount = await db.query('SELECT COUNT(*) as count FROM daily_metrics');
  if (parseInt(metricsCount.rows[0].count) === 0) {
    await seedData();
  }
}

async function seedData() {
  console.log('Seeding deterministic data...');

  // Fixed seed data for 30 days
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

  // Categories - 6 rows, one long label, one >= 1M
  const categories = [
    { name: 'Direct', value: 245000 },
    { name: 'Organic Search', value: 189000 },
    { name: 'Paid Search', value: 132000 },
    { name: 'Social Media', value: 98000 },
    { name: 'Enterprise Infrastructure & Compliance', value: 1250000 },
    { name: 'Referral', value: 76000 }
  ];

  for (const cat of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [cat.name, cat.value]
    );
  }

  // Recent items - 20 rows
  const itemNames = [
    'Acme Corp Subscription', 'Beta Analytics Pro', 'Cloud Storage Plus',
    'Enterprise License', 'Freemium Upgrade', 'Growth Hacking Kit',
    'Insights Dashboard', 'Jira Integration', 'Knowledge Base Access',
    'Lead Gen Package', 'Marketing Suite', 'Newsletter Pro',
    'Optimization Tool', 'Premium Support', 'Query Builder',
    'Reporting Module', 'Sales CRM Addon', 'Team Collaboration',
    'User Analytics', 'Video Conferencing'
  ];
  const itemCategories = ['SaaS', 'Analytics', 'Infrastructure', 'Marketing', 'Support'];

  for (let i = 0; i < 20; i++) {
    const name = itemNames[i % itemNames.length];
    const category = itemCategories[i % itemCategories.length];
    const value = 5000 + (i * 1234) % 45000;
    const created = new Date(baseDate);
    created.setDate(created.getDate() + (i % 30));
    const createdStr = created.toISOString();
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, createdStr]
    );
  }

  // Default settings
  await db.query(
    "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT DO NOTHING"
  );

  console.log('Seeding complete.');
}

async function getSummary() {
  const totalVisitors = await db.query('SELECT SUM(visitors) as total FROM daily_metrics');
  const totalRevenue = await db.query('SELECT SUM(revenue) as total FROM daily_metrics');
  const bestDay = await db.query('SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1');
  const last7 = await db.query(`
    SELECT SUM(visitors) as sum FROM daily_metrics 
    WHERE date >= (SELECT MAX(date) - INTERVAL '7 days' FROM daily_metrics)
  `);
  const prev7 = await db.query(`
    SELECT SUM(visitors) as sum FROM daily_metrics 
    WHERE date >= (SELECT MAX(date) - INTERVAL '14 days' FROM daily_metrics)
    AND date < (SELECT MAX(date) - INTERVAL '7 days' FROM daily_metrics)
  `);

  const tv = parseInt(totalVisitors.rows[0].total) || 0;
  const tr = parseInt(totalRevenue.rows[0].total) || 0;
  const bd = bestDay.rows[0];
  const l7 = parseInt(last7.rows[0].sum) || 0;
  const p7 = parseInt(prev7.rows[0].sum) || 1;
  const trend = p7 > 0 ? Math.round(((l7 - p7) / p7) * 100) : 0;

  return {
    totalVisitors: tv,
    totalRevenue: tr,
    bestDay: { date: bd.date, visitors: bd.visitors },
    sevenDayTrend: trend
  };
}

app.get('/api/summary', async (req, res) => {
  try {
    const summary = await getSummary();
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/timeseries', async (req, res) => {
  try {
    const result = await db.query('SELECT date, visitors, revenue FROM daily_metrics ORDER BY date');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const result = await db.query('SELECT name, value FROM categories ORDER BY value DESC');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/recent', async (req, res) => {
  try {
    const result = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const result = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    const theme = result.rows[0]?.value || 'light';
    res.json({ theme });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function startServer() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);