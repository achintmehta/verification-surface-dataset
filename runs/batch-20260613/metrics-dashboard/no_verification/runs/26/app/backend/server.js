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
const DATA_DIR = path.join(__dirname, 'pgdata');

app.use(cors());
app.use(express.json());

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let db;

async function initDb() {
  db = new PGlite({ dataDir: DATA_DIR });
  await db.waitReady;

  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date TEXT PRIMARY KEY,
      visitors INTEGER,
      revenue INTEGER
    );
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT,
      value INTEGER
    );
    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
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

  // Check if seeded
  const { rows: metricCount } = await db.query('SELECT COUNT(*) as count FROM daily_metrics');
  if (parseInt(metricCount[0].count) === 0) {
    await seedData();
  }
}

async function seedData() {
  // Deterministic seed data - 30 days
  const dailyMetrics = [];
  const baseDate = new Date('2024-01-01');
  let visitors = 1200;
  let revenue = 45000;
  for (let i = 0; i < 30; i++) {
    const date = new Date(baseDate);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];
    // Deterministic variation
    visitors = Math.floor(visitors * (0.95 + ((i % 7) * 0.01))) + 50 + (i % 5) * 20;
    revenue = Math.floor(revenue * (0.97 + ((i % 5) * 0.015))) + 2000 + (i % 3) * 500;
    dailyMetrics.push({ date: dateStr, visitors, revenue });
  }

  for (const m of dailyMetrics) {
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [m.date, m.visitors, m.revenue]
    );
  }

  // Categories - 6 rows, one long label, one >= 1M
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1250000 },
    { name: 'SaaS Subscriptions', value: 890000 },
    { name: 'Professional Services', value: 475000 },
    { name: 'Hardware Sales', value: 320000 },
    { name: 'Training & Education', value: 185000 },
    { name: 'Support Contracts', value: 95000 }
  ];

  for (const c of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [c.name, c.value]
    );
  }

  // Recent items - 20 rows
  const recentItems = [
    { name: 'Acme Corp Renewal', category: 'SaaS Subscriptions', value: 45000, created_at: '2024-01-30' },
    { name: 'Cloud Migration Project', category: 'Professional Services', value: 125000, created_at: '2024-01-29' },
    { name: 'Server Hardware Bundle', category: 'Hardware Sales', value: 78000, created_at: '2024-01-28' },
    { name: 'Compliance Audit', category: 'Enterprise Infrastructure & Compliance', value: 95000, created_at: '2024-01-27' },
    { name: 'Team Onboarding Workshop', category: 'Training & Education', value: 12000, created_at: '2024-01-26' },
    { name: 'Annual Support Plan', category: 'Support Contracts', value: 25000, created_at: '2024-01-25' },
    { name: 'Data Analytics Platform', category: 'SaaS Subscriptions', value: 67000, created_at: '2024-01-24' },
    { name: 'Security Assessment', category: 'Enterprise Infrastructure & Compliance', value: 83000, created_at: '2024-01-23' },
    { name: 'Custom Integration', category: 'Professional Services', value: 54000, created_at: '2024-01-22' },
    { name: 'Network Equipment', category: 'Hardware Sales', value: 92000, created_at: '2024-01-21' },
    { name: 'Leadership Training', category: 'Training & Education', value: 18000, created_at: '2024-01-20' },
    { name: 'Premium Support Tier', category: 'Support Contracts', value: 35000, created_at: '2024-01-19' },
    { name: 'Enterprise License', category: 'SaaS Subscriptions', value: 210000, created_at: '2024-01-18' },
    { name: 'Infrastructure Setup', category: 'Enterprise Infrastructure & Compliance', value: 150000, created_at: '2024-01-17' },
    { name: 'Consulting Retainer', category: 'Professional Services', value: 88000, created_at: '2024-01-16' },
    { name: 'Workstation Fleet', category: 'Hardware Sales', value: 145000, created_at: '2024-01-15' },
    { name: 'Certification Program', category: 'Training & Education', value: 27000, created_at: '2024-01-14' },
    { name: 'Maintenance Contract', category: 'Support Contracts', value: 42000, created_at: '2024-01-13' },
    { name: 'API Access Package', category: 'SaaS Subscriptions', value: 33000, created_at: '2024-01-12' },
    { name: 'Disaster Recovery Setup', category: 'Enterprise Infrastructure & Compliance', value: 110000, created_at: '2024-01-11' }
  ];

  for (const item of recentItems) {
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [item.name, item.category, item.value, item.created_at]
    );
  }

  // Default settings
  await db.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
    ['theme', 'light']
  );
}

async function getSummary() {
  const { rows: visitorsRows } = await db.query('SELECT SUM(visitors) as total FROM daily_metrics');
  const totalVisitors = parseInt(visitorsRows[0].total) || 0;

  const { rows: revenueRows } = await db.query('SELECT SUM(revenue) as total FROM daily_metrics');
  const totalRevenue = parseInt(revenueRows[0].total) || 0;

  const { rows: bestDayRows } = await db.query('SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1');
  const bestDay = bestDayRows[0] ? bestDayRows[0].date : null;

  // 7-day trend: compare last 7 days avg to previous 7
  const { rows: recent } = await db.query(`
    SELECT visitors FROM daily_metrics 
    ORDER BY date DESC LIMIT 14
  `);
  let trend = 0;
  if (recent.length >= 14) {
    const last7 = recent.slice(0, 7).reduce((a, b) => a + b.visitors, 0) / 7;
    const prev7 = recent.slice(7, 14).reduce((a, b) => a + b.visitors, 0) / 7;
    trend = prev7 > 0 ? Math.round(((last7 - prev7) / prev7) * 100) : 0;
  }

  return { totalVisitors, totalRevenue, bestDay, trend7Day: trend };
}

// API Routes
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
    const { rows } = await db.query('SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT name, value FROM categories ORDER BY value DESC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/recent', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const { rows } = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    const theme = rows[0] ? rows[0].value : 'light';
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

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});