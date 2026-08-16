import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'metrics.db');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Initialize PGLite
let db;

async function initDb() {
  const exists = await fs.access(DB_PATH).then(() => true).catch(() => false);
  db = new PGlite(`file://${DB_PATH}`);
  await db.waitReady;

  if (!exists) {
    await seedDatabase();
  }
}

async function seedDatabase() {
  console.log('Seeding database with deterministic data...');

  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date TEXT PRIMARY KEY,
      visitors INTEGER,
      revenue INTEGER
    );
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY,
      name TEXT,
      value INTEGER
    );
    CREATE TABLE IF NOT EXISTS recent_items (
      id INTEGER PRIMARY KEY,
      name TEXT,
      category TEXT,
      value INTEGER,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Seed daily_metrics: 30 days, deterministic
  const baseDate = new Date('2024-01-01');
  for (let i = 0; i < 30; i++) {
    const date = new Date(baseDate);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];
    // Deterministic: visitors ~ 1000 + sin wave + i*10, revenue similar
    const visitors = Math.floor(1200 + Math.sin(i / 5) * 300 + i * 5);
    const revenue = Math.floor(visitors * (45 + Math.cos(i / 3) * 10));
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, visitors, revenue]
    );
  }

  // Seed categories: 6 rows, one long label, one >=1M
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1250000 },
    { name: 'SaaS Subscriptions', value: 890000 },
    { name: 'Professional Services', value: 450000 },
    { name: 'Hardware Sales', value: 320000 },
    { name: 'Training & Education', value: 180000 },
    { name: 'Support Contracts', value: 95000 }
  ];
  for (let i = 0; i < categories.length; i++) {
    await db.query(
      'INSERT INTO categories (id, name, value) VALUES ($1, $2, $3)',
      [i + 1, categories[i].name, categories[i].value]
    );
  }

  // Seed recent_items: 20 rows
  const items = [
    'Acme Corp', 'Beta Inc', 'Gamma LLC', 'Delta Systems', 'Epsilon Ltd',
    'Zeta Partners', 'Eta Solutions', 'Theta Tech', 'Iota Innovations', 'Kappa Group',
    'Lambda Analytics', 'Mu Dynamics', 'Nu Ventures', 'Xi Corporation', 'Omicron Labs',
    'Pi Software', 'Rho Holdings', 'Sigma Networks', 'Tau Industries', 'Upsilon Co'
  ];
  const cats = ['Enterprise', 'SaaS', 'Services', 'Hardware', 'Training', 'Support'];
  for (let i = 0; i < 20; i++) {
    const name = items[i];
    const cat = cats[i % cats.length];
    const value = 5000 + (i * 1234) % 45000;
    const created = new Date(baseDate);
    created.setDate(created.getDate() + (29 - (i % 30)));
    const createdStr = created.toISOString();
    await db.query(
      'INSERT INTO recent_items (id, name, category, value, created_at) VALUES ($1, $2, $3, $4, $5)',
      [i + 1, name, cat, value, createdStr]
    );
  }

  // Default settings
  await db.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    ['theme', 'light']
  );

  console.log('Database seeded successfully.');
}

// API Routes

app.get('/api/summary', async (req, res) => {
  try {
    const visitorsRes = await db.query('SELECT SUM(visitors) as total_visitors FROM daily_metrics');
    const revenueRes = await db.query('SELECT SUM(revenue) as total_revenue FROM daily_metrics');
    const bestDayRes = await db.query('SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1');
    const last7 = await db.query(`
      SELECT SUM(visitors) as last7 FROM daily_metrics 
      WHERE date >= (SELECT MAX(date) FROM daily_metrics) - INTERVAL '6 days'
    `);
    const prev7 = await db.query(`
      SELECT SUM(visitors) as prev7 FROM daily_metrics 
      WHERE date >= (SELECT MAX(date) FROM daily_metrics) - INTERVAL '13 days'
      AND date < (SELECT MAX(date) FROM daily_metrics) - INTERVAL '6 days'
    `);

    const totalVisitors = visitorsRes.rows[0].total_visitors || 0;
    const totalRevenue = revenueRes.rows[0].total_revenue || 0;
    const bestDay = bestDayRes.rows[0] ? bestDayRes.rows[0].date : null;
    const bestDayVisitors = bestDayRes.rows[0] ? bestDayRes.rows[0].visitors : 0;

    const l7 = last7.rows[0].last7 || 0;
    const p7 = prev7.rows[0].prev7 || 1; // avoid div0
    const trend = Math.round(((l7 - p7) / p7) * 100);

    res.json({
      totalVisitors,
      totalRevenue,
      bestDay,
      bestDayVisitors,
      sevenDayTrend: trend
    });
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
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      ['theme', theme]
    );
    res.json({ theme });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);