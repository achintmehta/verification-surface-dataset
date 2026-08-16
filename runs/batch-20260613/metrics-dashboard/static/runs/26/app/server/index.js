import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = 3001;

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
}

async function seedData() {
  // Deterministic seed data - 30 days
  const baseDate = new Date('2024-01-01');
  const metricsInserts = [];
  let totalVisitors = 0;
  let totalRevenue = 0;
  let maxRevenue = 0;
  let bestDay = '';

  for (let i = 0; i < 30; i++) {
    const date = new Date(baseDate);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];
    // Deterministic values
    const visitors = 1200 + Math.floor(Math.sin(i / 5) * 300) + (i % 7) * 50;
    const revenue = (8000 + Math.floor(Math.cos(i / 4) * 2000) + (i % 5) * 300).toFixed(2);
    metricsInserts.push(`('${dateStr}', ${visitors}, ${revenue})`);
    totalVisitors += visitors;
    totalRevenue += parseFloat(revenue);
    if (parseFloat(revenue) > maxRevenue) {
      maxRevenue = parseFloat(revenue);
      bestDay = dateStr;
    }
  }

  await db.exec(`
    INSERT INTO daily_metrics (date, visitors, revenue) VALUES 
    ${metricsInserts.join(', ')}
  `);

  // Categories - 6 rows, one long label, one >= 1M
  await db.exec(`
    INSERT INTO categories (name, value) VALUES 
    ('Direct', 1250000),
    ('Organic Search', 890000),
    ('Paid Search', 645000),
    ('Social Media', 420000),
    ('Referral', 315000),
    ('Enterprise Infrastructure & Compliance', 275000)
  `);

  // Recent items - 20 rows
  const recentInserts = [];
  const categories = ['Direct', 'Organic Search', 'Paid Search', 'Social Media', 'Referral', 'Enterprise Infrastructure & Compliance'];
  for (let i = 1; i <= 20; i++) {
    const cat = categories[i % categories.length];
    const value = (500 + i * 123.45).toFixed(2);
    const created = new Date(baseDate);
    created.setDate(created.getDate() + (30 - i));
    const createdStr = created.toISOString();
    recentInserts.push(`('Item ${i}', '${cat}', ${value}, '${createdStr}')`);
  }
  await db.exec(`
    INSERT INTO recent_items (name, category, value, created_at) VALUES 
    ${recentInserts.join(', ')}
  `);

  // Default settings
  await db.exec(`
    INSERT INTO settings (key, value) VALUES ('theme', 'light')
    ON CONFLICT (key) DO NOTHING
  `);
}

async function getSummary() {
  const visitorsRes = await db.query('SELECT SUM(visitors) as total FROM daily_metrics');
  const revenueRes = await db.query('SELECT SUM(revenue) as total FROM daily_metrics');
  const bestRes = await db.query('SELECT date, revenue FROM daily_metrics ORDER BY revenue DESC LIMIT 1');
  const last7 = await db.query(`
    SELECT visitors FROM daily_metrics 
    ORDER BY date DESC LIMIT 7
  `);
  const prev7 = await db.query(`
    SELECT visitors FROM daily_metrics 
    ORDER BY date DESC LIMIT 14 OFFSET 7
  `);

  const totalVisitors = parseInt(visitorsRes.rows[0].total);
  const totalRevenue = parseFloat(revenueRes.rows[0].total).toFixed(2);
  const bestDay = bestRes.rows[0].date;
  const bestRevenue = parseFloat(bestRes.rows[0].revenue);

  // 7-day trend
  const sumLast7 = last7.rows.reduce((sum, r) => sum + parseInt(r.visitors), 0);
  const sumPrev7 = prev7.rows.reduce((sum, r) => sum + parseInt(r.visitors), 0);
  const trend = sumPrev7 > 0 ? ((sumLast7 - sumPrev7) / sumPrev7 * 100).toFixed(1) : '0.0';

  return {
    totalVisitors,
    totalRevenue: parseFloat(totalRevenue),
    bestDay,
    bestRevenue,
    sevenDayTrend: parseFloat(trend)
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
    await db.query(`
      INSERT INTO settings (key, value) VALUES ('theme', $1)
      ON CONFLICT (key) DO UPDATE SET value = $1
    `, [theme]);
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