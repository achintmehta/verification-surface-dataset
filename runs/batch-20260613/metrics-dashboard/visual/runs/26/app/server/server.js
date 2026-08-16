import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3001;

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
  console.log('Seeding deterministic data...');

  // Seed 30 days of metrics (2024-01-01 to 2024-01-30)
  const metrics = [];
  let baseVisitors = 1200;
  let baseRevenue = 45000;
  for (let i = 0; i < 30; i++) {
    const date = new Date(2024, 0, i + 1);
    const dateStr = date.toISOString().split('T')[0];
    // Deterministic variation
    const visitors = Math.floor(baseVisitors + Math.sin(i / 5) * 300 + (i % 7) * 50);
    const revenue = parseFloat((baseRevenue + Math.cos(i / 4) * 15000 + (i % 5) * 2000).toFixed(2));
    metrics.push({ date: dateStr, visitors, revenue });
  }

  for (const m of metrics) {
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [m.date, m.visitors, m.revenue]
    );
  }

  // Seed 6 categories, one long name, one >= 1,000,000
  const categories = [
    { name: 'Direct Sales', value: 245000 },
    { name: 'Enterprise Infrastructure & Compliance', value: 1250000 },
    { name: 'Marketing Campaigns', value: 890000 },
    { name: 'Partnerships', value: 567000 },
    { name: 'Subscriptions', value: 1340000 },
    { name: 'Consulting', value: 423000 }
  ];

  for (const c of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [c.name, c.value]
    );
  }

  // Seed 20 recent items
  const items = [
    { name: 'Acme Corp License', category: 'Enterprise', value: 45000, created_at: '2024-01-30 09:15:00' },
    { name: 'Startup Bundle', category: 'Direct', value: 1200, created_at: '2024-01-30 08:45:00' },
    { name: 'Compliance Audit', category: 'Consulting', value: 89000, created_at: '2024-01-29 16:20:00' },
    { name: 'Marketing Package Q4', category: 'Marketing', value: 23400, created_at: '2024-01-29 14:10:00' },
    { name: 'Partner Integration', category: 'Partnerships', value: 56700, created_at: '2024-01-28 11:30:00' },
    { name: 'Annual Subscription', category: 'Subscriptions', value: 120000, created_at: '2024-01-28 10:05:00' },
    { name: 'Enterprise Support', category: 'Enterprise', value: 78000, created_at: '2024-01-27 15:40:00' },
    { name: 'Growth Hacking', category: 'Marketing', value: 15600, created_at: '2024-01-27 13:25:00' },
    { name: 'Reseller Deal', category: 'Partnerships', value: 34500, created_at: '2024-01-26 09:50:00' },
    { name: 'Pro Plan Renewal', category: 'Subscriptions', value: 89000, created_at: '2024-01-26 08:15:00' },
    { name: 'Custom Development', category: 'Consulting', value: 125000, created_at: '2024-01-25 17:00:00' },
    { name: 'SMB License', category: 'Direct', value: 8900, created_at: '2024-01-25 12:30:00' },
    { name: 'Security Review', category: 'Enterprise', value: 67000, created_at: '2024-01-24 14:45:00' },
    { name: 'Ad Campaign', category: 'Marketing', value: 45000, created_at: '2024-01-24 11:20:00' },
    { name: 'Channel Partner', category: 'Partnerships', value: 23400, created_at: '2024-01-23 10:10:00' },
    { name: 'Team License', category: 'Subscriptions', value: 56000, created_at: '2024-01-23 09:00:00' },
    { name: 'Strategy Session', category: 'Consulting', value: 34000, created_at: '2024-01-22 16:55:00' },
    { name: 'Retail Outlet', category: 'Direct', value: 15600, created_at: '2024-01-22 15:30:00' },
    { name: 'Brand Refresh', category: 'Marketing', value: 28900, created_at: '2024-01-21 13:40:00' },
    { name: 'Affiliate Payout', category: 'Partnerships', value: 12300, created_at: '2024-01-21 08:25:00' }
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

  console.log('Seeding complete.');
}

await initDb();

// API Endpoints

app.get('/api/summary', async (req, res) => {
  try {
    const { rows: totalVisitorsRows } = await db.query('SELECT SUM(visitors) as total FROM daily_metrics');
    const totalVisitors = parseInt(totalVisitorsRows[0].total);

    const { rows: totalRevenueRows } = await db.query('SELECT SUM(revenue) as total FROM daily_metrics');
    const totalRevenue = parseFloat(totalRevenueRows[0].total).toFixed(2);

    const { rows: bestDayRows } = await db.query('SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1');
    const bestDay = bestDayRows[0].date;

    // 7-day trend: compare last 7 days avg to previous 7
    const { rows: recent } = await db.query(`
      SELECT AVG(visitors) as avg_visitors FROM (
        SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 7
      ) sub
    `);
    const { rows: previous } = await db.query(`
      SELECT AVG(visitors) as avg_visitors FROM (
        SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 14 OFFSET 7
      ) sub
    `);
    const recentAvg = parseFloat(recent[0].avg_visitors);
    const prevAvg = parseFloat(previous[0].avg_visitors);
    const trend = prevAvg > 0 ? Math.round(((recentAvg - prevAvg) / prevAvg) * 100) : 0;

    res.json({
      totalVisitors,
      totalRevenue: parseFloat(totalRevenue),
      bestDay,
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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});