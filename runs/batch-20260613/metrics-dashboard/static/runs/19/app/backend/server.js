const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const dbPath = path.join(__dirname, 'pglite-data');
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
      { name: 'Enterprise Infrastructure & Compliance', value: 1250000 },
      { name: 'Consumer Electronics', value: 850000 },
      { name: 'Software Subscriptions', value: 450000 },
      { name: 'Consulting Services', value: 300000 },
      { name: 'Hardware Maintenance', value: 150000 },
      { name: 'Miscellaneous', value: 50000 }
    ];
    for (const c of cats) {
      await db.query(`INSERT INTO categories (name, value) VALUES ($1, $2)`, [c.name, c.value]);
    }

    // Seed recent_items
    for (let i = 0; i < 20; i++) {
      const name = \`Item \${i + 1}\`;
      const category = cats[i % cats.length].name;
      const value = 100 + (i * 15.5);
      const created_at = new Date(new Date('2023-09-30T12:00:00Z').getTime() - i * 3600000).toISOString();
      await db.query(\`INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)\`, [name, category, value, created_at]);
    }

    // Seed settings
    await db.query(\`INSERT INTO settings (key, value) VALUES ('theme', 'light')\`);
  }
}

initDb().catch(console.error);

app.get('/api/summary', async (req, res) => {
  try {
    const metrics = await db.query(\`SELECT * FROM daily_metrics ORDER BY date ASC\`);
    const rows = metrics.rows;
    if (rows.length === 0) return res.json({ totalVisitors: 0, totalRevenue: 0, bestDay: null, trend: 0 });

    let totalVisitors = 0;
    let totalRevenue = 0;
    let bestDay = rows[0];

    for (const row of rows) {
      totalVisitors += parseInt(row.visitors);
      totalRevenue += parseFloat(row.revenue);
      if (parseFloat(row.revenue) > parseFloat(bestDay.revenue)) {
        bestDay = row;
      }
    }

    // 7-day trend %: (last 7 days revenue - previous 7 days revenue) / previous 7 days revenue * 100
    const last7 = rows.slice(-7).reduce((sum, r) => sum + parseFloat(r.revenue), 0);
    const prev7 = rows.slice(-14, -7).reduce((sum, r) => sum + parseFloat(r.revenue), 0);
    const trend = prev7 === 0 ? 0 : ((last7 - prev7) / prev7) * 100;

    res.json({
      totalVisitors,
      totalRevenue,
      bestDay: { date: bestDay.date, revenue: parseFloat(bestDay.revenue) },
      trend: trend
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/timeseries', async (req, res) => {
  try {
    const metrics = await db.query(\`SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC\`);
    res.json(metrics.rows.map(r => ({ date: r.date, visitors: parseInt(r.visitors), revenue: parseFloat(r.revenue) })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const cats = await db.query(\`SELECT name, value FROM categories ORDER BY value DESC\`);
    res.json(cats.rows.map(r => ({ name: r.name, value: parseFloat(r.value) })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/recent', async (req, res) => {
  try {
    const items = await db.query(\`SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC\`);
    res.json(items.rows.map(r => ({ name: r.name, category: r.category, value: parseFloat(r.value), created_at: r.created_at })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const settings = await db.query(\`SELECT value FROM settings WHERE key = 'theme'\`);
    res.json({ theme: settings.rows.length > 0 ? settings.rows[0].value : 'light' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const { theme } = req.body;
    if (theme !== 'light' && theme !== 'dark') return res.status(400).json({ error: 'Invalid theme' });
    
    const exists = await db.query(\`SELECT value FROM settings WHERE key = 'theme'\`);
    if (exists.rows.length > 0) {
      await db.query(\`UPDATE settings SET value = $1 WHERE key = 'theme'\`, [theme]);
    } else {
      await db.query(\`INSERT INTO settings (key, value) VALUES ('theme', $1)\`, [theme]);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(\`Backend listening on port \${PORT}\`);
});
