import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

let db;

async function initDb() {
  db = new PGlite('./pglite-data');
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
  const { rows } = await db.query('SELECT COUNT(*) as count FROM daily_metrics');
  if (parseInt(rows[0].count) === 0) {
    await seedData();
  }
}

function seededRandom(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

async function seedData() {
  const today = new Date();
  const dailyData = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const seed = i + 42;
    const visitors = 800 + Math.floor(seededRandom(seed) * 1200);
    const revenue = 15000 + Math.floor(seededRandom(seed + 1) * 85000);
    dailyData.push({ date: dateStr, visitors, revenue });
  }

  for (const item of dailyData) {
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [item.date, item.visitors, item.revenue]
    );
  }

  const categories = [
    { name: 'Marketing', value: 125000 },
    { name: 'Sales', value: 98000 },
    { name: 'Support', value: 67000 },
    { name: 'Development', value: 145000 },
    { name: 'Enterprise Infrastructure & Compliance', value: 1250000 },
    { name: 'Operations', value: 82000 }
  ];

  for (const cat of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [cat.name, cat.value]
    );
  }

  const items = [];
  const itemNames = ['Acme Corp', 'Beta Inc', 'Gamma LLC', 'Delta Co', 'Epsilon Ltd', 'Zeta SA', 'Eta GmbH', 'Theta Inc', 'Iota Corp', 'Kappa LLC'];
  const cats = ['Marketing', 'Sales', 'Support', 'Development', 'Enterprise Infrastructure & Compliance', 'Operations'];
  for (let i = 0; i < 20; i++) {
    const seed = i * 7;
    const name = itemNames[i % itemNames.length] + (i > 9 ? ' ' + (i-9) : '');
    const cat = cats[Math.floor(seededRandom(seed) * cats.length)];
    const value = 1000 + Math.floor(seededRandom(seed + 1) * 25000);
    const created = new Date(today.getTime() - (i * 86400000 * 0.5)).toISOString();
    items.push({ name, category: cat, value, created_at: created });
  }

  for (const item of items) {
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [item.name, item.category, item.value, item.created_at]
    );
  }

  await db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT DO NOTHING', ['theme', 'light']);
}

async function getSummary() {
  const visitorsRes = await db.query('SELECT SUM(visitors) as total FROM daily_metrics');
  const revenueRes = await db.query('SELECT SUM(revenue) as total FROM daily_metrics');
  const bestDayRes = await db.query('SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1');
  const last7 = await db.query('SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 7');
  const prev7 = await db.query('SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 14 OFFSET 7');

  const totalVisitors = parseInt(visitorsRes.rows[0].total);
  const totalRevenue = parseInt(revenueRes.rows[0].total);
  const bestDay = bestDayRes.rows[0].date;
  const bestVisitors = bestDayRes.rows[0].visitors;

  const sumLast7 = last7.rows.reduce((a, r) => a + parseInt(r.visitors), 0);
  const sumPrev7 = prev7.rows.reduce((a, r) => a + parseInt(r.visitors), 0);
  const trend = sumPrev7 === 0 ? 0 : Math.round(((sumLast7 - sumPrev7) / sumPrev7) * 100);

  return {
    totalVisitors,
    totalRevenue,
    bestDay,
    bestDayVisitors: bestVisitors,
    sevenDayTrend: trend
  };
}

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
    const { rows } = await db.query('SELECT * FROM daily_metrics ORDER BY date ASC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM categories ORDER BY value DESC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/recent', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM recent_items ORDER BY created_at DESC LIMIT 20');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const { rows } = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    const theme = rows.length > 0 ? rows[0].value : 'light';
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

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);