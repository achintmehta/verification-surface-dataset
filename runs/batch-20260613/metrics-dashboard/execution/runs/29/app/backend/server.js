import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// Initialize PGLite with file system persistence
const db = new PGlite(join(__dirname, 'pgdata'));

async function initDb() {
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
      value BIGINT NOT NULL
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
  const { rows: metricCount } = await db.query('SELECT COUNT(*) as count FROM daily_metrics');
  if (parseInt(metricCount[0].count) === 0) {
    await seedData();
  }
}

async function seedData() {
  // Deterministic seed data - 30 days
  const startDate = new Date('2024-01-01');
  const dailyData = [];
  for (let i = 0; i < 30; i++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];
    // Deterministic values based on day
    const visitors = 120 + Math.floor(Math.sin(i / 5) * 40) + (i % 7) * 5;
    const revenue = (1500 + Math.floor(Math.cos(i / 4) * 800) + (i % 5) * 100).toFixed(2);
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
    { name: 'Direct Sales', value: 450000 },
    { name: 'Enterprise Infrastructure & Compliance', value: 1250000 },
    { name: 'Marketing Campaigns', value: 320000 },
    { name: 'Partnerships', value: 890000 },
    { name: 'Subscriptions', value: 670000 },
    { name: 'Consulting', value: 210000 }
  ];

  for (const c of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [c.name, c.value]
    );
  }

  // 20 recent items
  const itemNames = [
    'Q4 Report', 'Client Onboarding', 'Server Upgrade', 'Marketing Kit',
    'Partnership Deal', 'Subscription Renewal', 'Consulting Session',
    'Product Launch', 'Team Training', 'Budget Review', 'Strategy Meeting',
    'Vendor Contract', 'Customer Survey', 'Feature Release', 'Security Audit',
    'Performance Review', 'Sales Pipeline', 'Support Ticket', 'Invoice Processing',
    'Project Kickoff'
  ];
  const itemCategories = ['Sales', 'Operations', 'Marketing', 'Support', 'Finance'];

  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const cat = itemCategories[i % itemCategories.length];
    const value = (500 + (i * 137) % 4500).toFixed(2);
    const created = new Date(startDate);
    created.setDate(created.getDate() + (i % 30));
    const createdStr = created.toISOString();
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, cat, value, createdStr]
    );
  }

  // Default settings
  await db.query(
    "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT DO NOTHING"
  );
}

// API Routes

app.get('/api/summary', async (req, res) => {
  try {
    const { rows: visitorsRows } = await db.query('SELECT SUM(visitors) as total FROM daily_metrics');
    const totalVisitors = parseInt(visitorsRows[0].total) || 0;

    const { rows: revenueRows } = await db.query('SELECT SUM(revenue) as total FROM daily_metrics');
    const totalRevenue = parseFloat(revenueRows[0].total || 0).toFixed(2);

    const { rows: bestDayRows } = await db.query(
      'SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1'
    );
    const bestDay = bestDayRows[0] ? bestDayRows[0].date : null;

    // 7-day trend: compare last 7 vs previous 7
    const { rows: recent } = await db.query(
      'SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 14'
    );
    let trend = 0;
    if (recent.length >= 14) {
      const last7 = recent.slice(0, 7).reduce((a, b) => a + b.visitors, 0);
      const prev7 = recent.slice(7, 14).reduce((a, b) => a + b.visitors, 0);
      trend = prev7 > 0 ? Math.round(((last7 - prev7) / prev7) * 100) : 0;
    }

    res.json({
      totalVisitors,
      totalRevenue,
      bestDay,
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