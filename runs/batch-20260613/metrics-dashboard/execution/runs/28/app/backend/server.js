import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = 3000;

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

function seededRandom(seed) {
  let x = Math.sin(seed++) * 10000;
  return x - Math.floor(x);
}

async function seedData() {
  const today = new Date('2024-10-01');
  const metrics = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    // Deterministic values
    const visitors = 800 + Math.floor(seededRandom(i * 1) * 400);
    const revenue = 5000 + Math.floor(seededRandom(i * 2) * 15000);
    metrics.push({ date: dateStr, visitors, revenue });
  }

  for (const m of metrics) {
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [m.date, m.visitors, m.revenue]
    );
  }

  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 2450000 },
    { name: 'SaaS Subscriptions', value: 1890000 },
    { name: 'Professional Services', value: 920000 },
    { name: 'Hardware Sales', value: 675000 },
    { name: 'Training & Education', value: 340000 },
    { name: 'Support Contracts', value: 285000 }
  ];

  for (const c of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [c.name, c.value]
    );
  }

  const items = [];
  const itemNames = [
    'Acme Corp Renewal', 'TechStart Inc', 'Global Systems Ltd', 'Innovate Partners',
    'Quantum Dynamics', 'Nexus Solutions', 'Pinnacle Group', 'Vertex Analytics',
    'Horizon Labs', 'Summit Tech', 'Apex Industries', 'Core Dynamics',
    'Prime Ventures', 'Elite Systems', 'Fusion Networks', 'Atlas Corp',
    'Zenith Partners', 'Omega Solutions', 'Pioneer Tech', 'Vanguard Ltd'
  ];
  const cats = ['Enterprise', 'SaaS', 'Services', 'Hardware', 'Training', 'Support'];
  for (let i = 0; i < 20; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - (i % 10));
    items.push({
      name: itemNames[i],
      category: cats[i % cats.length],
      value: 15000 + Math.floor(seededRandom(i * 3) * 85000),
      created_at: d.toISOString().split('T')[0]
    });
  }

  for (const item of items) {
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [item.name, item.category, item.value, item.created_at]
    );
  }

  await db.query(
    "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT DO NOTHING"
  );
}

app.get('/api/summary', async (req, res) => {
  try {
    const { rows: visitorsRows } = await db.query('SELECT SUM(visitors) as total FROM daily_metrics');
    const totalVisitors = parseInt(visitorsRows[0].total) || 0;

    const { rows: revenueRows } = await db.query('SELECT SUM(revenue) as total FROM daily_metrics');
    const totalRevenue = parseInt(revenueRows[0].total) || 0;

    const { rows: bestDayRows } = await db.query('SELECT date, revenue FROM daily_metrics ORDER BY revenue DESC LIMIT 1');
    const bestDay = bestDayRows[0] ? bestDayRows[0].revenue : 0;

    // 7-day trend: compare last 7 vs previous 7
    const { rows: recent } = await db.query('SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 14');
    let trend = 0;
    if (recent.length >= 14) {
      const last7 = recent.slice(0,7).reduce((a,b) => a + b.visitors, 0);
      const prev7 = recent.slice(7,14).reduce((a,b) => a + b.visitors, 0);
      trend = prev7 > 0 ? Math.round(((last7 - prev7) / prev7) * 100) : 0;
    }

    res.json({
      totalVisitors,
      totalRevenue,
      bestDay,
      trend
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
    const { rows } = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC, id DESC LIMIT 20');
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