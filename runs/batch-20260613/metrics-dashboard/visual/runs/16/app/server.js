import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./pglite-data');

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date DATE PRIMARY KEY,
      visitors INTEGER,
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
    let metricsSql = 'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ';
    const metricsValues = [];
    let baseDate = new Date('2023-10-01T00:00:00Z');
    for (let i = 0; i < 30; i++) {
      const d = new Date(baseDate);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().split('T')[0];
      // Deterministic values
      const visitors = 15000 + (i * 500) + (i % 3) * 100;
      const revenue = visitors * 2.5 + (i % 5) * 150;
      metricsValues.push(`('${dateStr}', ${visitors}, ${revenue})`);
    }
    await db.exec(metricsSql + metricsValues.join(', ') + ';');

    // Seed categories
    await db.exec(`
      INSERT INTO categories (name, value) VALUES
      ('Enterprise Infrastructure & Compliance', 1250000),
      ('Consumer Electronics', 45000),
      ('Software Subscriptions', 85000),
      ('Consulting Services', 32000),
      ('Hardware Sales', 15000),
      ('Other', 5000);
    `);

    // Seed recent_items
    let itemsSql = 'INSERT INTO recent_items (name, category, value, created_at) VALUES ';
    const itemsValues = [];
    for (let i = 0; i < 20; i++) {
      const name = `Item ${i + 1}`;
      const category = i % 2 === 0 ? 'Enterprise Infrastructure & Compliance' : 'Consumer Electronics';
      const value = 100 + i * 10;
      const d = new Date(baseDate);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().replace('T', ' ').substring(0, 19);
      itemsValues.push(`('${name}', '${category}', ${value}, '${dateStr}')`);
    }
    await db.exec(itemsSql + itemsValues.join(', ') + ';');

    // Seed settings
    await db.exec(`INSERT INTO settings (key, value) VALUES ('theme', 'light');`);
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
    const last7 = metrics.slice(-7);
    const prev7 = metrics.slice(-14, -7);
    const last7Rev = last7.reduce((sum, m) => sum + parseFloat(m.revenue), 0);
    const prev7Rev = prev7.reduce((sum, m) => sum + parseFloat(m.revenue), 0);
    const trend = prev7Rev === 0 ? 0 : ((last7Rev - prev7Rev) / prev7Rev) * 100;

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
    if (theme !== 'light' && theme !== 'dark') {
      return res.status(400).json({ error: 'Invalid theme' });
    }
    await db.query("UPDATE settings SET value = $1 WHERE key = 'theme'", [theme]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});