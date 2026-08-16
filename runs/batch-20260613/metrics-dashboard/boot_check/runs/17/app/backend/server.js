const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

let db;

async function initDb() {
  const { PGlite } = await import('@electric-sql/pglite');
  db = new PGlite('./pglite-data');

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

  const { rows: metricsCount } = await db.query('SELECT COUNT(*) as count FROM daily_metrics');
  if (parseInt(metricsCount[0].count) === 0) {
    // Seed daily_metrics (30 days)
    let date = new Date('2023-01-01T00:00:00Z');
    for (let i = 0; i < 30; i++) {
      const dateStr = date.toISOString().split('T')[0];
      const visitors = 100 + Math.floor(Math.sin(i) * 50) + i * 5;
      const revenue = visitors * 10 + Math.floor(Math.cos(i) * 100);
      await db.query('INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)', [dateStr, visitors, revenue]);
      date.setDate(date.getDate() + 1);
    }

    // Seed categories
    const cats = [
      ['Enterprise Infrastructure & Compliance', 1250000],
      ['Consumer Electronics', 450000],
      ['Software Subscriptions', 300000],
      ['Consulting Services', 150000],
      ['Hardware Sales', 80000],
      ['Miscellaneous', 20000]
    ];
    for (const [name, value] of cats) {
      await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [name, value]);
    }

    // Seed recent_items
    for (let i = 0; i < 20; i++) {
      await db.query('INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)', [
        `Item ${i + 1}`,
        cats[i % cats.length][0],
        Math.floor(Math.random() * 10000),
        new Date(Date.now() - i * 3600000).toISOString()
      ]);
    }

    // Seed settings
    await db.query('INSERT INTO settings (key, value) VALUES ($1, $2)', ['theme', 'light']);
  }
}

initDb().catch(console.error);

app.get('/api/summary', async (req, res) => {
  try {
    const { rows: metrics } = await db.query('SELECT * FROM daily_metrics ORDER BY date ASC');
    const totalVisitors = metrics.reduce((sum, row) => sum + row.visitors, 0);
    const totalRevenue = metrics.reduce((sum, row) => sum + parseFloat(row.revenue), 0);
    const bestDay = metrics.reduce((max, row) => parseFloat(row.revenue) > parseFloat(max.revenue) ? row : max, metrics[0]);
    
    // 7-day trend %
    const last7 = metrics.slice(-7);
    const prev7 = metrics.slice(-14, -7);
    const last7Rev = last7.reduce((sum, row) => sum + parseFloat(row.revenue), 0);
    const prev7Rev = prev7.reduce((sum, row) => sum + parseFloat(row.revenue), 0);
    const trend = prev7Rev === 0 ? 0 : ((last7Rev - prev7Rev) / prev7Rev) * 100;

    res.json({
      totalVisitors,
      totalRevenue,
      bestDay: { date: bestDay.date, revenue: parseFloat(bestDay.revenue) },
      trend: trend.toFixed(2)
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
    const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', ['theme']);
    res.json({ theme: rows.length > 0 ? rows[0].value : 'light' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const { theme } = req.body;
    if (theme !== 'light' && theme !== 'dark') {
      return res.status(400).json({ error: 'Invalid theme' });
    }
    await db.query('UPDATE settings SET value = $1 WHERE key = $2', [theme, 'theme']);
    res.json({ theme });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
