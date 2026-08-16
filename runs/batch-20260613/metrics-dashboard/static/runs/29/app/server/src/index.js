import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Initialize PGLite with file system persistence
const db = new PGlite('./metrics.db');

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

  // Check if seeded
  const { rows: metricCount } = await db.query('SELECT COUNT(*) as count FROM daily_metrics');
  if (parseInt(metricCount[0].count) === 0) {
    await seedData();
  }
}

async function seedData() {
  // Deterministic seed: 30 days of data
  const baseDate = new Date('2024-01-01');
  const metrics = [];
  for (let i = 0; i < 30; i++) {
    const date = new Date(baseDate);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];
    // Deterministic values based on index
    const visitors = 1200 + Math.floor(Math.sin(i / 5) * 300) + (i % 7) * 50;
    const revenue = 45000 + Math.floor(Math.cos(i / 4) * 15000) + (i % 5) * 2000;
    metrics.push({ date: dateStr, visitors, revenue });
  }

  for (const m of metrics) {
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [m.date, m.visitors, m.revenue]
    );
  }

  // 6 categories, one long label, one >=1M value
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1250000 },
    { name: 'SaaS Subscriptions', value: 890000 },
    { name: 'Professional Services', value: 675000 },
    { name: 'Hardware Sales', value: 420000 },
    { name: 'Training & Education', value: 285000 },
    { name: 'Support Contracts', value: 195000 }
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
    { name: 'Cloud Migration Project', category: 'Professional Services', value: 125000, created_at: '2024-01-29' },
    { name: 'Server Hardware Bundle', category: 'Hardware Sales', value: 89000, created_at: '2024-01-28' },
    { name: 'Compliance Audit', category: 'Enterprise Infrastructure & Compliance', value: 67000, created_at: '2024-01-27' },
    { name: 'Staff Training Program', category: 'Training & Education', value: 23000, created_at: '2024-01-26' },
    { name: 'Annual Support Plan', category: 'Support Contracts', value: 34000, created_at: '2024-01-25' },
    { name: 'Data Analytics Platform', category: 'SaaS Subscriptions', value: 78000, created_at: '2024-01-24' },
    { name: 'Network Upgrade', category: 'Professional Services', value: 56000, created_at: '2024-01-23' },
    { name: 'Laptop Fleet Refresh', category: 'Hardware Sales', value: 112000, created_at: '2024-01-22' },
    { name: 'Security Assessment', category: 'Enterprise Infrastructure & Compliance', value: 41000, created_at: '2024-01-21' },
    { name: 'Leadership Workshop', category: 'Training & Education', value: 19000, created_at: '2024-01-20' },
    { name: 'Premium Support Tier', category: 'Support Contracts', value: 52000, created_at: '2024-01-19' },
    { name: 'CRM Integration', category: 'SaaS Subscriptions', value: 63000, created_at: '2024-01-18' },
    { name: 'Database Optimization', category: 'Professional Services', value: 47000, created_at: '2024-01-17' },
    { name: 'Storage Expansion', category: 'Hardware Sales', value: 38000, created_at: '2024-01-16' },
    { name: 'GDPR Compliance Review', category: 'Enterprise Infrastructure & Compliance', value: 29000, created_at: '2024-01-15' },
    { name: 'Developer Onboarding', category: 'Training & Education', value: 15000, created_at: '2024-01-14' },
    { name: 'Extended Warranty', category: 'Support Contracts', value: 27000, created_at: '2024-01-13' },
    { name: 'Marketing Automation', category: 'SaaS Subscriptions', value: 55000, created_at: '2024-01-12' },
    { name: 'IT Consulting Retainer', category: 'Professional Services', value: 98000, created_at: '2024-01-11' }
  ];

  for (const item of items) {
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [item.name, item.category, item.value, item.created_at]
    );
  }

  // Default settings
  await db.query(
    "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING"
  );
}

await initDb();

// API Routes

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
    const { rows } = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC');
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
