const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const dbPath = path.join(__dirname, 'pglite-data');
let db;

async function initDb() {
  const { PGlite } = await import('@electric-sql/pglite');
  db = new PGlite(dbPath);
  await db.waitReady;
  
  await db.query(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date DATE PRIMARY KEY,
      visitors INT,
      revenue INT
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT,
      value INT
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT,
      category TEXT,
      value INT,
      created_at TIMESTAMP
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const res = await db.query(`SELECT COUNT(*) as count FROM daily_metrics`);
  if (parseInt(res.rows[0].count) === 0) {
    let metricsValues = [];
    let baseVisitors = 1000;
    let baseRevenue = 50000;
    const baseDate = new Date('2024-01-31T00:00:00Z');
    for (let i = 30; i >= 1; i--) {
      const d = new Date(baseDate);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const v = baseVisitors + (i * 17) % 300;
      const r = baseRevenue + (i * 53) % 1000;
      metricsValues.push(`('${dateStr}', ${v}, ${r})`);
    }
    await db.query(`INSERT INTO daily_metrics (date, visitors, revenue) VALUES ${metricsValues.join(',')}`);

    await db.query(`
      INSERT INTO categories (name, value) VALUES
      ('Enterprise Infrastructure & Compliance', 1250000),
      ('Consumer Electronics', 450000),
      ('Software Subscriptions', 320000),
      ('Consulting Services', 150000),
      ('Hardware Sales', 80000),
      ('Miscellaneous', 25000)
    `);

    let itemsValues = [];
    const baseItemDate = new Date('2024-01-31T12:00:00Z');
    for (let i = 1; i <= 20; i++) {
      const d = new Date(baseItemDate);
      d.setHours(d.getHours() - i * 5);
      const dateStr = d.toISOString().replace('T', ' ').substring(0, 19);
      const val = 100 + (i * 37) % 500;
      itemsValues.push(`('Item ${i}', 'Category ${(i%6)+1}', ${val}, '${dateStr}')`);
    }
    await db.query(`INSERT INTO recent_items (name, category, value, created_at) VALUES ${itemsValues.join(',')}`);

    await db.query(`INSERT INTO settings (key, value) VALUES ('theme', 'light')`);
  }
}

initDb().catch(console.error);

app.get('/api/summary', async (req, res) => {
  try {
    const metrics = await db.query(`SELECT to_char(date, 'YYYY-MM-DD') as date, visitors, revenue FROM daily_metrics ORDER BY date ASC`);
    const rows = metrics.rows;
    if (rows.length === 0) return res.json({ totalVisitors: 0, totalRevenue: 0, bestDay: null, trend: 0 });

    const totalVisitors = rows.reduce((sum, r) => sum + r.visitors, 0);
    const totalRevenue = rows.reduce((sum, r) => sum + r.revenue, 0);
    
    let bestDay = rows[0];
    for (const r of rows) {
      if (r.revenue > bestDay.revenue) bestDay = r;
    }

    const last7 = rows.slice(-7);
    const prev7 = rows.slice(-14, -7);
    const last7Rev = last7.reduce((sum, r) => sum + r.revenue, 0);
    const prev7Rev = prev7.reduce((sum, r) => sum + r.revenue, 0);
    const trend = prev7Rev === 0 ? 0 : ((last7Rev - prev7Rev) / prev7Rev) * 100;

    res.json({
      totalVisitors,
      totalRevenue,
      bestDay: bestDay.date,
      trend: trend.toFixed(1)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/timeseries', async (req, res) => {
  try {
    const metrics = await db.query(`SELECT to_char(date, 'YYYY-MM-DD') as date, visitors, revenue FROM daily_metrics ORDER BY date ASC`);
    res.json(metrics.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const cats = await db.query(`SELECT name, value FROM categories ORDER BY value DESC`);
    res.json(cats.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/recent', async (req, res) => {
  try {
    const items = await db.query(`SELECT name, category, value, to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') as created_at FROM recent_items ORDER BY created_at DESC LIMIT 20`);
    res.json(items.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const settings = await db.query(`SELECT value FROM settings WHERE key = 'theme'`);
    res.json({ theme: settings.rows[0]?.value || 'light' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const { theme } = req.body;
    if (theme !== 'light' && theme !== 'dark') return res.status(400).json({ error: 'Invalid theme' });
    await db.query(`UPDATE settings SET value = $1 WHERE key = 'theme'`, [theme]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});