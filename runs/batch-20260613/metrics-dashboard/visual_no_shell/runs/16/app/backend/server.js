const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./pglite-data');

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date DATE PRIMARY KEY,
      visitors INT,
      revenue NUMERIC
    );
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT,
      value NUMERIC
    );
    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT,
      category TEXT,
      value NUMERIC,
      created_at TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const { rows: metricsRows } = await db.query('SELECT count(*) as count FROM daily_metrics');
  if (parseInt(metricsRows[0].count) === 0) {
    // Seed daily_metrics (30 days)
    let metricsInsert = 'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ';
    const metricsValues = [];
    let baseDate = new Date('2023-10-01T00:00:00Z');
    for (let i = 0; i < 30; i++) {
      const d = new Date(baseDate);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().split('T')[0];
      // Deterministic values
      const visitors = 1000 + (i * 50) + (i % 3 === 0 ? 200 : 0) - (i % 7 === 0 ? 150 : 0);
      const revenue = visitors * 2.5 + (i % 5 === 0 ? 500 : 0);
      metricsValues.push(`('${dateStr}', ${visitors}, ${revenue})`);
    }
    await db.exec(metricsInsert + metricsValues.join(', '));

    // Seed categories
    await db.exec(`
      INSERT INTO categories (name, value) VALUES
      ('Enterprise Infrastructure & Compliance', 1250000),
      ('Consumer Electronics', 450000),
      ('Software Subscriptions', 320000),
      ('Consulting Services', 150000),
      ('Hardware Sales', 80000),
      ('Miscellaneous', 25000)
    `);

    // Seed recent_items
    let itemsInsert = 'INSERT INTO recent_items (name, category, value, created_at) VALUES ';
    const itemsValues = [];
    for (let i = 0; i < 20; i++) {
      const name = `Item ${i + 1}`;
      const category = i % 2 === 0 ? 'Enterprise Infrastructure & Compliance' : 'Consumer Electronics';
      const value = 100 + i * 10;
      const d = new Date(baseDate);
      d.setDate(d.getDate() + 29);
      d.setHours(10 + i, 0, 0, 0);
      itemsValues.push(`('${name}', '${category}', ${value}, '${d.toISOString()}')`);
    }
    await db.exec(itemsInsert + itemsValues.join(', '));

    // Seed settings
    await db.exec(`INSERT INTO settings (key, value) VALUES ('theme', 'light')`);
  }
}

initDb().catch(console.error);

app.get('/api/summary', async (req, res) => {
  try {
    const { rows: metrics } = await db.query('SELECT * FROM daily_metrics ORDER BY date ASC');
    let totalVisitors = 0;
    let totalRevenue = 0;
    let bestDayRevenue = 0;
    
    metrics.forEach(m => {
      totalVisitors += m.visitors;
      const rev = parseFloat(m.revenue);
      totalRevenue += rev;
      if (rev > bestDayRevenue) bestDayRevenue = rev;
    });

    // 7-day trend %
    // Compare last 7 days to previous 7 days
    let last7Revenue = 0;
    let prev7Revenue = 0;
    for (let i = 23; i < 30; i++) last7Revenue += parseFloat(metrics[i].revenue);
    for (let i = 16; i < 23; i++) prev7Revenue += parseFloat(metrics[i].revenue);
    
    const trend = prev7Revenue === 0 ? 0 : ((last7Revenue - prev7Revenue) / prev7Revenue) * 100;

    res.json({
      totalVisitors,
      totalRevenue,
      bestDayRevenue,
      trendPercent: trend
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
    const { rows } = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const { rows } = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    res.json({ theme: rows.length > 0 ? rows[0].value : 'light' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const { theme } = req.body;
    if (theme === 'light' || theme === 'dark') {
      await db.query("UPDATE settings SET value = $1 WHERE key = 'theme'", [theme]);
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'Invalid theme' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
