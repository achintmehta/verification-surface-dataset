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

const db = new PGlite(`file://${DATA_DIR}/metrics.db`);

async function initDb() {
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

  const { rows } = await db.query('SELECT COUNT(*) as count FROM daily_metrics');
  if (parseInt(rows[0].count) === 0) {
    await seedData();
  }
}

async function seedData() {
  // Deterministic seed - fixed data for 30 days
  const dailyData = [];
  const baseDate = new Date('2024-01-01');
  let visitors = 1200;
  let revenue = 45000;
  for (let i = 0; i < 30; i++) {
    const date = new Date(baseDate);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];
    // Deterministic variation
    visitors = Math.floor(1000 + Math.sin(i / 5) * 300 + (i % 7) * 50);
    revenue = Math.floor(40000 + Math.cos(i / 4) * 15000 + (i % 5) * 2000);
    dailyData.push({ date: dateStr, visitors, revenue });
  }

  for (const d of dailyData) {
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [d.date, d.visitors, d.revenue]
    );
  }

  // 6 categories, one long label, one >=1M
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1250000 },
    { name: 'SaaS Subscriptions', value: 890000 },
    { name: 'Professional Services', value: 345000 },
    { name: 'Hardware Sales', value: 567000 },
    { name: 'Training & Education', value: 123000 },
    { name: 'Support Contracts', value: 234000 }
  ];

  for (const c of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [c.name, c.value]
    );
  }

  // 20 recent items
  const items = [
    { name: 'Acme Corp Renewal', category: 'SaaS Subscriptions', value: 45000, created_at: '2024-01-30' },
    { name: 'GlobalTech Setup', category: 'Professional Services', value: 125000, created_at: '2024-01-29' },
    { name: 'Server Cluster Order', category: 'Hardware Sales', value: 89000, created_at: '2024-01-28' },
    { name: 'Compliance Audit', category: 'Enterprise Infrastructure & Compliance', value: 320000, created_at: '2024-01-27' },
    { name: 'Staff Onboarding', category: 'Training & Education', value: 15000, created_at: '2024-01-26' },
    { name: 'Premium Support', category: 'Support Contracts', value: 28000, created_at: '2024-01-25' },
    { name: 'Data Migration', category: 'Professional Services', value: 67000, created_at: '2024-01-24' },
    { name: 'License Upgrade', category: 'SaaS Subscriptions', value: 78000, created_at: '2024-01-23' },
    { name: 'Network Equipment', category: 'Hardware Sales', value: 145000, created_at: '2024-01-22' },
    { name: 'Security Review', category: 'Enterprise Infrastructure & Compliance', value: 95000, created_at: '2024-01-21' },
    { name: 'Workshop Series', category: 'Training & Education', value: 22000, created_at: '2024-01-20' },
    { name: 'Annual Maintenance', category: 'Support Contracts', value: 41000, created_at: '2024-01-19' },
    { name: 'Cloud Integration', category: 'Professional Services', value: 88000, created_at: '2024-01-18' },
    { name: 'Enterprise License', category: 'SaaS Subscriptions', value: 210000, created_at: '2024-01-17' },
    { name: 'Workstation Batch', category: 'Hardware Sales', value: 56000, created_at: '2024-01-16' },
    { name: 'Policy Update', category: 'Enterprise Infrastructure & Compliance', value: 48000, created_at: '2024-01-15' },
    { name: 'Certification Course', category: 'Training & Education', value: 18000, created_at: '2024-01-14' },
    { name: 'Extended Warranty', category: 'Support Contracts', value: 33000, created_at: '2024-01-13' },
    { name: 'Consulting Hours', category: 'Professional Services', value: 72000, created_at: '2024-01-12' },
    { name: 'Mobile App License', category: 'SaaS Subscriptions', value: 39000, created_at: '2024-01-11' }
  ];

  for (const item of items) {
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

await initDb();

// API Routes

app.get('/api/summary', async (req, res) => {
  try {
    const visitorsRes = await db.query('SELECT SUM(visitors) as total FROM daily_metrics');
    const totalVisitors = parseInt(visitorsRes.rows[0].total) || 0;

    const revenueRes = await db.query('SELECT SUM(revenue) as total FROM daily_metrics');
    const totalRevenue = parseInt(revenueRes.rows[0].total) || 0;

    const bestDayRes = await db.query('SELECT date, revenue FROM daily_metrics ORDER BY revenue DESC LIMIT 1');
    const bestDay = bestDayRes.rows[0] ? bestDayRes.rows[0].date : null;

    // 7-day trend: compare last 7 days to previous 7
    const recentRes = await db.query(`
      SELECT SUM(revenue) as last7 FROM daily_metrics 
      WHERE date >= (SELECT MAX(date) FROM daily_metrics) - INTERVAL '6 days'
    `);
    const prevRes = await db.query(`
      SELECT SUM(revenue) as prev7 FROM daily_metrics 
      WHERE date >= (SELECT MAX(date) FROM daily_metrics) - INTERVAL '13 days'
      AND date < (SELECT MAX(date) FROM daily_metrics) - INTERVAL '6 days'
    `);
    const last7 = parseInt(recentRes.rows[0]?.last7) || 0;
    const prev7 = parseInt(prevRes.rows[0]?.prev7) || 1;
    const trend = Math.round(((last7 - prev7) / prev7) * 100);

    res.json({
      totalVisitors,
      totalRevenue,
      bestDay,
      trend
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
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      ['theme', theme]
    );
    res.json({ theme });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});