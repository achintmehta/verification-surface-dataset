import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// PGLite setup
const dbPath = path.join(__dirname, 'pgdata');
const db = new PGlite(dbPath);

let dbInitialized = false;

async function initDb() {
  if (dbInitialized) return;
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
  const metricsCount = await db.query('SELECT COUNT(*) FROM daily_metrics');
  if (parseInt(metricsCount.rows[0].count) === 0) {
    await seedData();
  }
  dbInitialized = true;
}

function seededRandom(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

async function seedData() {
  const today = new Date();
  const metrics = [];
  for (let i = 29; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    // Deterministic values
    const seed = i * 42;
    const visitors = 1000 + Math.floor(seededRandom(seed) * 5000);
    const revenue = (5000 + seededRandom(seed + 1) * 15000).toFixed(2);
    metrics.push({ date: dateStr, visitors, revenue });
  }

  for (const m of metrics) {
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [m.date, m.visitors, m.revenue]
    );
  }

  // Categories - 6 rows, one long label, one >=1M
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 2450000 },
    { name: 'SaaS Subscriptions', value: 1875000 },
    { name: 'Professional Services', value: 920000 },
    { name: 'Hardware Sales', value: 675000 },
    { name: 'Training & Education', value: 340000 },
    { name: 'Support Contracts', value: 215000 }
  ];

  for (const c of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [c.name, c.value]
    );
  }

  // Recent items - 20 rows
  const itemNames = [
    'Acme Corp Renewal', 'BetaTech Upgrade', 'Gamma Solutions License',
    'Delta Systems Integration', 'Epsilon Analytics Platform', 'Zeta Cloud Migration',
    'Eta Security Audit', 'Theta Data Pipeline', 'Iota API Gateway', 'Kappa Monitoring Suite',
    'Lambda ML Training', 'Mu Compliance Review', 'Nu Infrastructure Setup',
    'Xi Performance Tuning', 'Omicron Backup Solution', 'Pi Dashboard Custom',
    'Rho Reporting Module', 'Sigma Alert System', 'Tau Optimization', 'Upsilon Scaling'
  ];
  const itemCategories = ['Enterprise', 'SaaS', 'Services', 'Hardware', 'Training', 'Support'];

  for (let i = 0; i < 20; i++) {
    const seed = i * 17;
    const name = itemNames[i % itemNames.length];
    const cat = itemCategories[Math.floor(seededRandom(seed) * itemCategories.length)];
    const value = (1000 + seededRandom(seed + 1) * 50000).toFixed(2);
    const created = new Date(today.getTime() - i * 86400000 * 1.5).toISOString();
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, cat, value, created]
    );
  }

  // Default settings
  await db.query(
    "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT DO NOTHING"
  );
}

async function getSummary() {
  const totalVisitors = await db.query('SELECT SUM(visitors) as total FROM daily_metrics');
  const totalRevenue = await db.query('SELECT SUM(revenue) as total FROM daily_metrics');
  const bestDay = await db.query('SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1');
  const last7 = await db.query(`
    SELECT SUM(visitors) as sum_vis FROM (
      SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 7
    ) t
  `);
  const prev7 = await db.query(`
    SELECT SUM(visitors) as sum_vis FROM (
      SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 14 OFFSET 7
    ) t
  `);
  const trend = last7.rows[0].sum_vis && prev7.rows[0].sum_vis 
    ? ((last7.rows[0].sum_vis - prev7.rows[0].sum_vis) / prev7.rows[0].sum_vis * 100).toFixed(1)
    : '0.0';

  return {
    totalVisitors: parseInt(totalVisitors.rows[0].total),
    totalRevenue: parseFloat(totalRevenue.rows[0].total).toFixed(2),
    bestDay: bestDay.rows[0].date,
    bestDayVisitors: bestDay.rows[0].visitors,
    sevenDayTrend: parseFloat(trend)
  };
}

app.use(async (req, res, next) => {
  await initDb();
  next();
});

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
    const result = await db.query('SELECT date, visitors, revenue FROM daily_metrics ORDER BY date');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const result = await db.query('SELECT name, value FROM categories ORDER BY value DESC');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/recent', async (req, res) => {
  try {
    const result = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const result = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    const theme = result.rows[0]?.value || 'light';
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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});