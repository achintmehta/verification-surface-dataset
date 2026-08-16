import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let db;

async function initDb() {
  db = new PGlite('./pgdata');
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
  // Deterministic seed - fixed data for 30 days
  const startDate = new Date('2024-01-01');
  const visitors = [120, 135, 98, 142, 156, 189, 210, 175, 198, 220, 245, 267, 189, 234, 256, 278, 301, 289, 312, 334, 356, 378, 401, 389, 412, 445, 467, 489, 512, 534];
  const revenues = [1250.50, 1420.75, 980.00, 1580.25, 1690.00, 2100.50, 2450.00, 1890.75, 2150.25, 2380.00, 2670.50, 2890.00, 2050.75, 2560.00, 2780.25, 3010.50, 3250.00, 3120.75, 3380.00, 3620.50, 3850.00, 4100.25, 4320.50, 4210.00, 4450.75, 4780.00, 5020.50, 5250.00, 5490.25, 5720.50];

  for (let i = 0; i < 30; i++) {
    const date = new Date(startDate);
    date.setDate(startDate.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, visitors[i], revenues[i]]
    );
  }

  // 6 categories, one long label, one >=1M
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1250000 },
    { name: 'SaaS Subscriptions', value: 890000 },
    { name: 'Professional Services', value: 456000 },
    { name: 'Hardware Sales', value: 234000 },
    { name: 'Training & Education', value: 123000 },
    { name: 'Support Contracts', value: 89000 }
  ];

  for (const cat of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [cat.name, cat.value]
    );
  }

  // 20 recent items
  const items = [
    { name: 'Acme Corp License', category: 'SaaS Subscriptions', value: 45000, created_at: '2024-01-30 09:15:00' },
    { name: 'GlobalTech Setup', category: 'Professional Services', value: 125000, created_at: '2024-01-30 08:45:00' },
    { name: 'Server Rack Pro', category: 'Hardware Sales', value: 8900, created_at: '2024-01-29 16:20:00' },
    { name: 'Compliance Audit', category: 'Enterprise Infrastructure & Compliance', value: 78000, created_at: '2024-01-29 14:10:00' },
    { name: 'Team Training Pack', category: 'Training & Education', value: 3200, created_at: '2024-01-29 11:30:00' },
    { name: 'Premium Support', category: 'Support Contracts', value: 15000, created_at: '2024-01-28 10:00:00' },
    { name: 'Startup Bundle', category: 'SaaS Subscriptions', value: 12000, created_at: '2024-01-28 09:45:00' },
    { name: 'Data Migration', category: 'Professional Services', value: 67000, created_at: '2024-01-27 15:55:00' },
    { name: 'Network Switch', category: 'Hardware Sales', value: 2450, created_at: '2024-01-27 13:40:00' },
    { name: 'Security Review', category: 'Enterprise Infrastructure & Compliance', value: 95000, created_at: '2024-01-26 11:20:00' },
    { name: 'Onsite Workshop', category: 'Training & Education', value: 8900, created_at: '2024-01-26 10:15:00' },
    { name: 'Annual Maintenance', category: 'Support Contracts', value: 28000, created_at: '2024-01-25 14:30:00' },
    { name: 'Cloud Credits', category: 'SaaS Subscriptions', value: 55000, created_at: '2024-01-25 12:00:00' },
    { name: 'Consulting Hours', category: 'Professional Services', value: 42000, created_at: '2024-01-24 16:45:00' },
    { name: 'Laptop Fleet', category: 'Hardware Sales', value: 15600, created_at: '2024-01-24 09:10:00' },
    { name: 'Policy Update', category: 'Enterprise Infrastructure & Compliance', value: 34000, created_at: '2024-01-23 15:00:00' },
    { name: 'Certification Course', category: 'Training & Education', value: 1500, created_at: '2024-01-23 11:25:00' },
    { name: 'Extended Warranty', category: 'Support Contracts', value: 6700, created_at: '2024-01-22 10:50:00' },
    { name: 'API Access', category: 'SaaS Subscriptions', value: 23000, created_at: '2024-01-22 08:30:00' },
    { name: 'Integration Work', category: 'Professional Services', value: 88000, created_at: '2024-01-21 17:15:00' }
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

app.get('/api/summary', async (req, res) => {
  try {
    const { rows: totalVisitors } = await db.query('SELECT SUM(visitors) as total FROM daily_metrics');
    const { rows: totalRevenue } = await db.query('SELECT SUM(revenue) as total FROM daily_metrics');
    const { rows: bestDay } = await db.query('SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1');
    const { rows: last7 } = await db.query('SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 7');
    const { rows: prev7 } = await db.query('SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 7 OFFSET 7');

    const sumLast7 = last7.reduce((a, b) => a + b.visitors, 0);
    const sumPrev7 = prev7.reduce((a, b) => a + b.visitors, 0);
    const trend = sumPrev7 > 0 ? Math.round(((sumLast7 - sumPrev7) / sumPrev7) * 100) : 0;

    res.json({
      totalVisitors: parseInt(totalVisitors[0].total),
      totalRevenue: parseFloat(totalRevenue[0].total).toFixed(2),
      bestDay: bestDay[0].date,
      bestDayVisitors: bestDay[0].visitors,
      sevenDayTrend: trend
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/timeseries', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC');
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
    const { rows } = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20');
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

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);