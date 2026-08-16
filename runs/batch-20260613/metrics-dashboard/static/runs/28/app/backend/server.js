import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

let db;

async function seedData() {
  // Deterministic seed data for 30 days
  const baseDate = new Date('2024-01-01');
  const dailyMetrics = [];
  const visitorsBase = [120, 135, 98, 142, 167, 189, 154, 201, 178, 165, 210, 233, 198, 176, 245, 267, 231, 198, 289, 312, 278, 256, 301, 334, 298, 275, 356, 389, 345, 312];
  const revenueBase = [12500, 14200, 9800, 15600, 18900, 21300, 16700, 23400, 19800, 18200, 25600, 28900, 22100, 19400, 31200, 34500, 27800, 23400, 36700, 40100, 33400, 29800, 38900, 42300, 36700, 31200, 45600, 48900, 41200, 37800];

  for (let i = 0; i < 30; i++) {
    const date = new Date(baseDate);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];
    dailyMetrics.push({
      date: dateStr,
      visitors: visitorsBase[i],
      revenue: revenueBase[i]
    });
  }

  for (const m of dailyMetrics) {
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [m.date, m.visitors, m.revenue]
    );
  }

  // Categories - 6 rows, one long name, one >=1M value
  const categories = [
    { name: 'Direct', value: 45200 },
    { name: 'Organic Search', value: 38900 },
    { name: 'Paid Search', value: 23400 },
    { name: 'Social Media', value: 18700 },
    { name: 'Enterprise Infrastructure & Compliance', value: 1250000 },
    { name: 'Referral', value: 9800 }
  ];

  for (const c of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [c.name, c.value]
    );
  }

  // Recent items - 20 rows
  const recentItems = [
    { name: 'Acme Corp Signup', category: 'Direct', value: 4500, created_at: '2024-01-30' },
    { name: 'Beta Ltd Renewal', category: 'Enterprise Infrastructure & Compliance', value: 125000, created_at: '2024-01-29' },
    { name: 'Gamma Inc Purchase', category: 'Paid Search', value: 8900, created_at: '2024-01-29' },
    { name: 'Delta Co Trial', category: 'Organic Search', value: 1200, created_at: '2024-01-28' },
    { name: 'Epsilon LLC Upgrade', category: 'Social Media', value: 34000, created_at: '2024-01-28' },
    { name: 'Zeta Partners Deal', category: 'Referral', value: 67000, created_at: '2024-01-27' },
    { name: 'Eta Solutions Contract', category: 'Direct', value: 28900, created_at: '2024-01-27' },
    { name: 'Theta Systems Order', category: 'Organic Search', value: 15600, created_at: '2024-01-26' },
    { name: 'Iota Media Campaign', category: 'Paid Search', value: 7800, created_at: '2024-01-26' },
    { name: 'Kappa Tech Subscription', category: 'Social Media', value: 45000, created_at: '2024-01-25' },
    { name: 'Lambda Analytics Pro', category: 'Enterprise Infrastructure & Compliance', value: 890000, created_at: '2024-01-25' },
    { name: 'Mu Dynamics License', category: 'Referral', value: 23400, created_at: '2024-01-24' },
    { name: 'Nu Innovations Buy', category: 'Direct', value: 12300, created_at: '2024-01-24' },
    { name: 'Xi Cloud Services', category: 'Organic Search', value: 56700, created_at: '2024-01-23' },
    { name: 'Omicron Startup Seed', category: 'Paid Search', value: 3400, created_at: '2024-01-23' },
    { name: 'Pi Networks Expansion', category: 'Social Media', value: 28900, created_at: '2024-01-22' },
    { name: 'Rho Ventures Round', category: 'Enterprise Infrastructure & Compliance', value: 450000, created_at: '2024-01-22' },
    { name: 'Sigma Retail POS', category: 'Referral', value: 17800, created_at: '2024-01-21' },
    { name: 'Tau Logistics Fleet', category: 'Direct', value: 92000, created_at: '2024-01-21' },
    { name: 'Upsilon Health App', category: 'Organic Search', value: 6700, created_at: '2024-01-20' }
  ];

  for (const item of recentItems) {
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

async function initDb() {
  db = new PGlite({ dataDir: `file://${path.join(__dirname, '.pglite')}` });
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

  const countRes = await db.query('SELECT COUNT(*) as count FROM daily_metrics');
  if (parseInt(countRes.rows[0].count) === 0) {
    await seedData();
  }
}

app.get('/api/summary', async (req, res) => {
  try {
    const visitorsRes = await db.query('SELECT SUM(visitors) as total FROM daily_metrics');
    const revenueRes = await db.query('SELECT SUM(revenue) as total FROM daily_metrics');
    const bestDayRes = await db.query('SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1');
    const last7Res = await db.query('SELECT SUM(visitors) as sum FROM daily_metrics ORDER BY date DESC LIMIT 7');
    const prev7Res = await db.query('SELECT SUM(visitors) as sum FROM (SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 14 OFFSET 7) t');

    const totalVisitors = parseInt(visitorsRes.rows[0].total) || 0;
    const totalRevenue = parseInt(revenueRes.rows[0].total) || 0;
    const bestDay = bestDayRes.rows[0] ? bestDayRes.rows[0].date : 'N/A';
    const last7 = parseInt(last7Res.rows[0]?.sum) || 0;
    const prev7 = parseInt(prev7Res.rows[0]?.sum) || 1;
    const trend = prev7 > 0 ? Math.round(((last7 - prev7) / prev7) * 100) : 0;

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
    const result = await db.query('SELECT * FROM daily_metrics ORDER BY date ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM categories ORDER BY value DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/recent', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM recent_items ORDER BY created_at DESC, id DESC LIMIT 20');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const result = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    const theme = result.rows[0]?.value || 'light';
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