const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const dbPath = path.join(__dirname, '..', 'pglite-data');
const db = new PGlite(dbPath);

async function initDb() {
  await db.waitReady;
  
  // Create tables
  await db.query(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date DATE PRIMARY KEY,
      visitors INT,
      revenue NUMERIC
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT,
      value NUMERIC
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT,
      category TEXT,
      value NUMERIC,
      created_at TIMESTAMP
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Check if seeded
  const res = await db.query(`SELECT count(*) as count FROM daily_metrics`);
  if (parseInt(res.rows[0].count) === 0) {
    // Seed daily_metrics (30 days)
    let date = new Date('2023-09-01T00:00:00Z');
    for (let i = 0; i < 30; i++) {
      const d = date.toISOString().split('T')[0];
      // Deterministic values
      const visitors = 1000 + (i * 50) + (i % 3 === 0 ? 200 : 0) - (i % 7 === 0 ? 150 : 0);
      const revenue = visitors * 2.5 + (i % 5 === 0 ? 500 : 0);
      await db.query(`INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)`, [d, visitors, revenue]);
      date.setDate(date.getDate() + 1);
    }

    // Seed categories
    const cats = [
      ['Enterprise Infrastructure & Compliance', 1250000],
      ['Consumer Electronics', 450000],
      ['Software Subscriptions', 320000],
      ['Consulting Services', 150000],
      ['Hardware Sales', 80000],
      ['Miscellaneous', 25000]
    ];
    for (const c of cats) {
      await db.query(`INSERT INTO categories (name, value) VALUES ($1, $2)`, c);
    }

    // Seed recent_items
    for (let i = 0; i < 20; i++) {
      const name = `Item ${1000 + i}`;
      const cat = cats[i % cats.length][0];
      const value = 100 + (i * 15.5);
      const created_at = new Date(new Date('2023-09-30T12:00:00Z').getTime() - i * 3600000).toISOString();
      await db.query(`INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)`, [name, cat, value, created_at]);
    }

    // Seed settings
    await db.query(`INSERT INTO settings (key, value) VALUES ('theme', 'light')`);
  }
}

initDb().catch(console.error);

app.get('/api/summary', async (req, res) => {
  try {
    const metrics = await db.query(`SELECT * FROM daily_metrics ORDER BY date ASC`);
    const rows = metrics.rows;
    if (rows.length === 0) return res.json({ totalVisitors: 0, totalRevenue: 0, bestDay: '', trend: 0 });

    let totalVisitors = 0;
    let totalRevenue = 0;
    let bestDayRevenue = 0;
    let bestDay = '';

    for (const r of rows) {
      totalVisitors += r.visitors;
      const rev = parseFloat(r.revenue);
      totalRevenue += rev;
      if (rev > bestDayRevenue) {
        bestDayRevenue = rev;
        bestDay = r.date;
      }
    }

    // 7-day trend %
    // Compare last 7 days to previous 7 days
    const last7 = rows.slice(-7);
    const prev7 = rows.slice(-14, -7);
    const last7Rev = last7.reduce((sum, r) => sum + parseFloat(r.revenue), 0);
    const prev7Rev = prev7.reduce((sum, r) => sum + parseFloat(r.revenue), 0);
    const trend = prev7Rev === 0 ? 0 : ((last7Rev - prev7Rev) / prev7Rev) * 100;

    res.json({
      totalVisitors,
      totalRevenue,
      bestDay,
      trend: trend.toFixed(1)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/timeseries', async (req, res) => {
  try {
    const metrics = await db.query(`SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC`);
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
    const items = await db.query(`SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20`);
    res.json(items.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const settings = await db.query(`SELECT value FROM settings WHERE key = 'theme'`);
    res.json({ theme: settings.rows.length > 0 ? settings.rows[0].value : 'light' });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});
