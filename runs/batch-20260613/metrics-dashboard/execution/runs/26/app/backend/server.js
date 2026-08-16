import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// Initialize PGlite with filesystem persistence
const db = new PGlite({ dataDir: './.pglite' });

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue DECIMAL(12,2) NOT NULL
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
  // Deterministic seed data - fixed values for 30 days
  const baseDate = new Date('2024-09-01');
  const visitors = [1240, 1350, 980, 1420, 1560, 1100, 1380, 1290, 1470, 1620, 1180, 1330, 1510, 1390, 1440, 1270, 1580, 1210, 1360, 1490, 1320, 1450, 1530, 1280, 1400, 1370, 1550, 1190, 1480, 1610];
  const revenues = [12450.50, 13520.00, 9820.75, 14230.25, 15680.00, 11045.50, 13890.00, 12975.25, 14760.50, 16230.00, 11890.75, 13345.00, 15120.50, 13980.25, 14450.00, 12765.50, 15890.00, 12130.75, 13670.00, 14980.50, 13245.25, 14560.00, 15320.75, 12890.50, 14080.00, 13750.25, 15540.50, 11980.00, 14890.75, 16150.00];

  for (let i = 0; i < 30; i++) {
    const date = new Date(baseDate);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, visitors[i], revenues[i]]
    );
  }

  // 6 categories, one long label, one >=1M
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1250000 },
    { name: 'SaaS Subscriptions', value: 875000 },
    { name: 'Professional Services', value: 620000 },
    { name: 'Hardware Sales', value: 445000 },
    { name: 'Training & Education', value: 285000 },
    { name: 'Support Contracts', value: 195000 }
  ];

  for (const cat of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [cat.name, cat.value]
    );
  }

  // 20 recent items
  const items = [
    { name: 'Acme Corp Renewal', category: 'SaaS Subscriptions', value: 45000, created: '2024-09-29 14:30:00' },
    { name: 'Cloud Migration Project', category: 'Professional Services', value: 125000, created: '2024-09-28 09:15:00' },
    { name: 'Server Hardware Bundle', category: 'Hardware Sales', value: 89000, created: '2024-09-27 16:45:00' },
    { name: 'Compliance Audit', category: 'Enterprise Infrastructure & Compliance', value: 67500, created: '2024-09-26 11:20:00' },
    { name: 'Staff Training Program', category: 'Training & Education', value: 32000, created: '2024-09-25 13:00:00' },
    { name: 'Annual Support Plan', category: 'Support Contracts', value: 28500, created: '2024-09-24 10:30:00' },
    { name: 'Data Analytics Platform', category: 'SaaS Subscriptions', value: 78000, created: '2024-09-23 15:10:00' },
    { name: 'Network Upgrade', category: 'Professional Services', value: 95000, created: '2024-09-22 08:45:00' },
    { name: 'Workstation Fleet', category: 'Hardware Sales', value: 156000, created: '2024-09-21 17:30:00' },
    { name: 'Security Assessment', category: 'Enterprise Infrastructure & Compliance', value: 42000, created: '2024-09-20 12:00:00' },
    { name: 'Leadership Workshop', category: 'Training & Education', value: 18500, created: '2024-09-19 14:20:00' },
    { name: 'Premium Support Tier', category: 'Support Contracts', value: 52000, created: '2024-09-18 09:50:00' },
    { name: 'CRM Integration', category: 'SaaS Subscriptions', value: 63000, created: '2024-09-17 16:00:00' },
    { name: 'Database Optimization', category: 'Professional Services', value: 48000, created: '2024-09-16 11:35:00' },
    { name: 'Storage Expansion', category: 'Hardware Sales', value: 72000, created: '2024-09-15 13:45:00' },
    { name: 'Policy Review', category: 'Enterprise Infrastructure & Compliance', value: 29000, created: '2024-09-14 10:10:00' },
    { name: 'Developer Onboarding', category: 'Training & Education', value: 24000, created: '2024-09-13 15:55:00' },
    { name: 'Maintenance Contract', category: 'Support Contracts', value: 38000, created: '2024-09-12 08:20:00' },
    { name: 'Project Management Tool', category: 'SaaS Subscriptions', value: 55000, created: '2024-09-11 14:40:00' },
    { name: 'IT Consulting', category: 'Professional Services', value: 87000, created: '2024-09-10 12:25:00' }
  ];

  for (const item of items) {
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [item.name, item.category, item.value, item.created]
    );
  }

  // Default settings
  await db.query(
    "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING"
  );

  console.log('Database seeded with deterministic data');
}

await initDb();

// API Routes

// GET /api/summary
app.get('/api/summary', async (req, res) => {
  try {
    const totalVisitors = await db.query('SELECT SUM(visitors) as total FROM daily_metrics');
    const totalRevenue = await db.query('SELECT SUM(revenue) as total FROM daily_metrics');
    const bestDay = await db.query('SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1');
    const last7 = await db.query('SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 7');
    const prev7 = await db.query('SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 7 OFFSET 7');

    const totalV = parseInt(totalVisitors.rows[0].total);
    const totalR = parseFloat(totalRevenue.rows[0].total);
    const best = bestDay.rows[0];
    const last7Visitors = last7.rows.map(r => r.visitors).reduce((a, b) => a + b, 0);
    const prev7Visitors = prev7.rows.map(r => r.visitors).reduce((a, b) => a + b, 0);
    const trend = prev7Visitors > 0 ? ((last7Visitors - prev7Visitors) / prev7Visitors * 100) : 0;

    res.json({
      totalVisitors: totalV,
      totalRevenue: totalR,
      bestDay: { date: best.date, visitors: best.visitors },
      sevenDayTrend: parseFloat(trend.toFixed(1))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/timeseries
app.get('/api/timeseries', async (req, res) => {
  try {
    const result = await db.query('SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/categories
app.get('/api/categories', async (req, res) => {
  try {
    const result = await db.query('SELECT name, value FROM categories ORDER BY value DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/recent
app.get('/api/recent', async (req, res) => {
  try {
    const result = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings
app.get('/api/settings', async (req, res) => {
  try {
    const result = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    const theme = result.rows.length > 0 ? result.rows[0].value : 'light';
    res.json({ theme });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings
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

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});