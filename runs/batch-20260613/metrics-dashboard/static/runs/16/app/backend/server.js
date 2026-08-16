const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const dbPath = path.join(__dirname, 'pglite-data');

let db;

async function initDB() {
  db = new PGlite(dbPath);
  await db.waitReady;

  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date DATE PRIMARY KEY,
      visitors INT NOT NULL,
      revenue NUMERIC NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      value NUMERIC NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      value NUMERIC NOT NULL,
      created_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Check if seeded
  const res = await db.query('SELECT COUNT(*) as count FROM daily_metrics');
  if (parseInt(res.rows[0].count) === 0) {
    console.log('Seeding database...');
    
    // Seed daily_metrics (30 days)
    let baseDate = new Date('2023-10-01T00:00:00Z');
    for (let i = 0; i < 30; i++) {
      const d = new Date(baseDate);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().split('T')[0];
      // Deterministic pseudo-random
      const visitors = 1000 + (i * 17) % 500 + (i % 3 === 0 ? 200 : 0);
      const revenue = 50000 + (i * 233) % 20000 + (i % 5 === 0 ? 10000 : 0);
      await db.query('INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)', [dateStr, visitors, revenue]);
    }

    // Seed categories
    const cats = [
      { name: 'Enterprise Infrastructure & Compliance', value: 1250000 },
      { name: 'Consumer Electronics', value: 450000 },
      { name: 'Software Subscriptions', value: 850000 },
      { name: 'Consulting Services', value: 320000 },
      { name: 'Hardware Sales', value: 610000 },
      { name: 'Miscellaneous', value: 150000 }
    ];
    for (const c of cats) {
      await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [c.name, c.value]);
    }

    // Seed recent_items
    for (let i = 0; i < 20; i++) {
      const name = \`Item \${i + 1}\`;
      const category = cats[i % cats.length].name;
      const value = 100 + (i * 37) % 900;
      const d = new Date(baseDate);
      d.setDate(d.getDate() + 29);
      d.setHours(10 + (i % 10), i % 60, 0);
      await db.query('INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)', [name, category, value, d.toISOString()]);
    }

    // Seed settings
    await db.query('INSERT INTO settings (key, value) VALUES ($1, $2)', ['theme', 'light']);
  }
}

// Routes
app.get('/api/summary', async (req, res) => {
  try {
    const metricsRes = await db.query('SELECT * FROM daily_metrics ORDER BY date ASC');
    const rows = metricsRes.rows;
    
    let totalVisitors = 0;
    let totalRevenue = 0;
    let bestDayRevenue = 0;
    
    rows.forEach(r => {
      totalVisitors += r.visitors;
      const rev = parseFloat(r.revenue);
      totalRevenue += rev;
      if (rev > bestDayRevenue) bestDayRevenue = rev;
    });

    // 7-day trend % (last 7 days vs previous 7 days revenue)
    const last7 = rows.slice(-7).reduce((sum, r) => sum + parseFloat(r.revenue), 0);
    const prev7 = rows.slice(-14, -7).reduce((sum, r) => sum + parseFloat(r.revenue), 0);
    const trend = prev7 === 0 ? 0 : ((last7 - prev7) / prev7) * 100;

    res.json({
      totalVisitors,
      totalRevenue,
      bestDayRevenue,
      trendPercent: trend
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/timeseries', async (req, res) => {
  try {
    const result = await db.query('SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const result = await db.query('SELECT name, value FROM categories ORDER BY value DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/recent', async (req, res) => {
  try {
    const result = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const result = await db.query('SELECT value FROM settings WHERE key = $1', ['theme']);
    const theme = result.rows.length > 0 ? result.rows[0].value : 'light';
    res.json({ theme });
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
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(\`Backend running on port \${PORT}\`);
  });
}).catch(err => {
  console.error('Failed to initialize DB', err);
  process.exit(1);
});
