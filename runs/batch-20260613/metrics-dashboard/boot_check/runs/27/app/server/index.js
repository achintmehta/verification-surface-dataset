import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'pgdata');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// Initialize PGLite
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
  const metricsCount = await db.query('SELECT COUNT(*) as count FROM daily_metrics');
  if (parseInt(metricsCount.rows[0].count) === 0) {
    await seedData();
  }
}

async function seedData() {
  // Deterministic seed data - fixed values
  const startDate = new Date('2024-01-01');
  
  // 30 days of metrics
  const metricsInserts = [];
  let seed = 42; // fixed seed for determinism
  function seededRandom() {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  }
  
  for (let i = 0; i < 30; i++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];
    const visitors = Math.floor(800 + seededRandom() * 1200); // 800-2000
    const revenue = (5000 + seededRandom() * 15000).toFixed(2); // 5000-20000
    metricsInserts.push(`('${dateStr}', ${visitors}, ${revenue})`);
  }
  
  await db.exec(`
    INSERT INTO daily_metrics (date, visitors, revenue) VALUES 
    ${metricsInserts.join(', ')}
  `);

  // 6 categories, one long label, one >= 1M
  await db.exec(`
    INSERT INTO categories (name, value) VALUES 
    ('Direct', 245000),
    ('Organic Search', 189000),
    ('Paid Ads', 132000),
    ('Social Media', 98000),
    ('Referral', 76000),
    ('Enterprise Infrastructure & Compliance', 1250000)
  `);

  // 20 recent items
  const items = [
    ['Acme Corp Subscription', 'Enterprise', 45000, '2024-01-30 14:22:00'],
    ['Cloud Storage Upgrade', 'Infrastructure', 12500, '2024-01-30 11:15:00'],
    ['API Access License', 'Enterprise', 89000, '2024-01-29 16:45:00'],
    ['Consulting Hours', 'Services', 3200, '2024-01-29 09:30:00'],
    ['Premium Support Plan', 'Enterprise', 15600, '2024-01-28 13:20:00'],
    ['Data Analytics Module', 'Infrastructure', 28750, '2024-01-28 10:05:00'],
    ['Security Audit', 'Compliance', 42000, '2024-01-27 15:40:00'],
    ['Mobile App License', 'Direct', 7800, '2024-01-27 08:55:00'],
    ['Training Session', 'Services', 1500, '2024-01-26 14:10:00'],
    ['Enterprise SSO Setup', 'Enterprise Infrastructure & Compliance', 67500, '2024-01-26 11:25:00'],
    ['Database Replication', 'Infrastructure', 33400, '2024-01-25 16:50:00'],
    ['Marketing Campaign', 'Paid Ads', 22000, '2024-01-25 09:15:00'],
    ['Compliance Report', 'Compliance', 18500, '2024-01-24 13:35:00'],
    ['User Management Addon', 'Enterprise', 9500, '2024-01-24 10:40:00'],
    ['Performance Tuning', 'Infrastructure', 12800, '2024-01-23 15:20:00'],
    ['Social Boost Package', 'Social Media', 4500, '2024-01-23 12:00:00'],
    ['Annual Renewal', 'Enterprise', 120000, '2024-01-22 14:45:00'],
    ['Integration Plugin', 'Referral', 6700, '2024-01-22 08:30:00'],
    ['Audit Trail Feature', 'Compliance', 21300, '2024-01-21 11:10:00'],
    ['Volume Discount Deal', 'Direct', 38500, '2024-01-21 16:55:00']
  ];

  const itemInserts = items.map(item => 
    `('${item[0]}', '${item[1]}', ${item[2]}, '${item[3]}')`
  );
  
  await db.exec(`
    INSERT INTO recent_items (name, category, value, created_at) VALUES 
    ${itemInserts.join(', ')}
  `);

  // Default settings
  await db.exec(`
    INSERT INTO settings (key, value) VALUES ('theme', 'light')
    ON CONFLICT (key) DO NOTHING
  `);
}

// API Routes

app.get('/api/summary', async (req, res) => {
  try {
    const totalVisitors = await db.query('SELECT SUM(visitors) as total FROM daily_metrics');
    const totalRevenue = await db.query('SELECT SUM(revenue) as total FROM daily_metrics');
    const bestDay = await db.query('SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1');
    const last7 = await db.query(`
      SELECT visitors FROM daily_metrics 
      ORDER BY date DESC LIMIT 7
    `);
    const prev7 = await db.query(`
      SELECT visitors FROM daily_metrics 
      ORDER BY date DESC LIMIT 14 OFFSET 7
    `);

    const sumLast7 = last7.rows.reduce((sum, r) => sum + r.visitors, 0);
    const sumPrev7 = prev7.rows.reduce((sum, r) => sum + r.visitors, 0);
    const trend = sumPrev7 > 0 ? ((sumLast7 - sumPrev7) / sumPrev7 * 100) : 0;

    res.json({
      totalVisitors: parseInt(totalVisitors.rows[0].total),
      totalRevenue: parseFloat(totalRevenue.rows[0].total).toFixed(2),
      bestDay: bestDay.rows[0].date.toISOString().split('T')[0],
      bestDayVisitors: bestDay.rows[0].visitors,
      sevenDayTrend: trend.toFixed(1)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/timeseries', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT date, visitors, revenue 
      FROM daily_metrics 
      ORDER BY date ASC
    `);
    res.json(result.rows.map(r => ({
      date: r.date.toISOString().split('T')[0],
      visitors: r.visitors,
      revenue: parseFloat(r.revenue)
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const result = await db.query('SELECT name, value FROM categories ORDER BY value DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/recent', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT name, category, value, created_at 
      FROM recent_items 
      ORDER BY created_at DESC
    `);
    res.json(result.rows.map(r => ({
      name: r.name,
      category: r.category,
      value: r.value,
      created_at: r.created_at.toISOString()
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const result = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    const theme = result.rows.length > 0 ? result.rows[0].value : 'light';
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
    await db.exec(`
      INSERT INTO settings (key, value) VALUES ('theme', '${theme}')
      ON CONFLICT (key) DO UPDATE SET value = '${theme}'
    `);
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