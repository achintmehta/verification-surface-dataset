import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

let db;

async function initDb() {
  db = new PGlite('./pgdata');
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
  // Deterministic seed: 30 days of data
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
      [dateStr, visitors, revenue]
    );
  }

  // 6 categories, one long label, one >=1M
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1250000 },
    { name: 'SaaS Subscriptions', value: 890000 },
    { name: 'Professional Services', value: 675000 },
    { name: 'Hardware Sales', value: 420000 },
    { name: 'Training & Support', value: 310000 },
    { name: 'Consulting', value: 245000 }
  ];

  for (const cat of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [cat.name, cat.value]
    );
  }

  // 20 recent items
  const itemNames = [
    'Acme Corp License Renewal', 'TechStart Inc Setup', 'Global Systems Audit',
    'Cloud Migration Project', 'Data Analytics Suite', 'Security Compliance Check',
    'Enterprise Backup Solution', 'API Integration Module', 'Performance Optimization',
    'User Training Session', 'Hardware Procurement', 'Software Update Package',
    'Network Infrastructure', 'Database Optimization', 'Mobile App Development',
    'IoT Device Management', 'AI Model Training', 'Blockchain Explorer Tool',
    'VR Training Platform', 'Quantum Computing Pilot'
  ];
  const itemCategories = ['Enterprise Infrastructure & Compliance', 'SaaS Subscriptions', 'Professional Services', 'Hardware Sales', 'Training & Support', 'Consulting'];

  for (let i = 0; i < 20; i++) {
    const name = itemNames[i % itemNames.length];
    const category = itemCategories[i % itemCategories.length];
    const value = 50000 + (i * 12345) % 200000;
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
    "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING"
  );
}

app.get('/api/summary', async (req, res) => {
  try {
    const { rows: visitorsRows } = await db.query('SELECT SUM(visitors) as total FROM daily_metrics');
    const totalVisitors = parseInt(visitorsRows[0].total) || 0;

    const { rows: revenueRows } = await db.query('SELECT SUM(revenue) as total FROM daily_metrics');
    const totalRevenue = parseInt(revenueRows[0].total) || 0;

    const { rows: bestDayRows } = await db.query('SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1');
    const bestDay = bestDayRows[0] ? bestDayRows[0].date : null;

    // 7-day trend: compare last 7 vs previous 7
    const { rows: recent } = await db.query('SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 14');
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
    const { rows } = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20');
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
      "INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [theme]
    );
    res.json({ theme });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);