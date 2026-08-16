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
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue DECIMAL(12,2) NOT NULL
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
      value DECIMAL(12,2) NOT NULL,
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

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

async function seedData() {
  const rand = seededRandom(42); // fixed seed

  // 30 days of metrics, starting from 2024-05-01
  const startDate = new Date('2024-05-01');
  for (let i = 0; i < 30; i++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];
    const visitors = Math.floor(800 + rand() * 1200); // 800-2000
    const revenue = (5000 + rand() * 15000).toFixed(2); // 5000-20000
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, visitors, revenue]
    );
  }

  // 6 categories, one long name, one >=1M
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 2450000 },
    { name: 'Cloud Services', value: 1875000 },
    { name: 'Data Analytics', value: 980000 },
    { name: 'Security Solutions', value: 1320000 },
    { name: 'AI & Machine Learning', value: 1650000 },
    { name: 'Consulting', value: 720000 }
  ];
  for (const cat of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [cat.name, cat.value]
    );
  }

  // 20 recent items
  const itemNames = [
    'Q3 Audit Report', 'Server Upgrade', 'New Client Onboarding', 'Security Patch v2.1',
    'Analytics Dashboard Update', 'Compliance Review', 'Cloud Migration Phase 1',
    'ML Model Training', 'Infrastructure Scaling', 'Data Pipeline Optimization',
    'Penetration Testing', 'User Training Session', 'API Gateway Config',
    'Backup System Overhaul', 'Performance Benchmarking', 'Vendor Evaluation',
    'Regulatory Filing', 'Team Expansion Plan', 'Software License Renewal',
    'Disaster Recovery Drill'
  ];
  const itemCategories = ['Enterprise Infrastructure & Compliance', 'Cloud Services', 'Data Analytics', 'Security Solutions', 'AI & Machine Learning', 'Consulting'];
  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const cat = itemCategories[i % itemCategories.length];
    const value = (10000 + rand() * 490000).toFixed(2);
    const created = new Date(startDate.getTime() + i * 86400000 * 1.5);
    const createdStr = created.toISOString();
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, cat, value, createdStr]
    );
  }

  // default settings
  await db.query(
    "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT DO NOTHING"
  );
}

app.get('/api/summary', async (req, res) => {
  try {
    const { rows: visitorsRows } = await db.query('SELECT SUM(visitors) as total_visitors FROM daily_metrics');
    const totalVisitors = parseInt(visitorsRows[0].total_visitors) || 0;

    const { rows: revenueRows } = await db.query('SELECT SUM(revenue) as total_revenue FROM daily_metrics');
    const totalRevenue = parseFloat(revenueRows[0].total_revenue) || 0;

    const { rows: bestDayRows } = await db.query('SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1');
    const bestDay = bestDayRows[0] ? bestDayRows[0].date.toISOString().split('T')[0] : null;
    const bestDayVisitors = bestDayRows[0] ? bestDayRows[0].visitors : 0;

    // 7-day trend: last 7 vs previous 7
    const { rows: recent } = await db.query('SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 14');
    let trend = 0;
    if (recent.length >= 14) {
      const last7 = recent.slice(0,7).reduce((a,b)=>a+b.visitors,0);
      const prev7 = recent.slice(7,14).reduce((a,b)=>a+b.visitors,0);
      trend = prev7 > 0 ? Math.round(((last7 - prev7) / prev7) * 100) : 0;
    }

    res.json({
      totalVisitors,
      totalRevenue: totalRevenue.toFixed(2),
      bestDay: bestDay ? `${bestDay} (${bestDayVisitors} visitors)` : 'N/A',
      sevenDayTrend: trend
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/timeseries', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC');
    res.json(rows.map(r => ({
      date: r.date.toISOString().split('T')[0],
      visitors: r.visitors,
      revenue: parseFloat(r.revenue)
    })));
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
    res.json(rows.map(r => ({
      name: r.name,
      category: r.category,
      value: parseFloat(r.value),
      created_at: r.created_at.toISOString()
    })));
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
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);