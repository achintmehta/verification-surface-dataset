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

const db = new PGlite(path.join(__dirname, 'pglite-data'));

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

  // Check if seeded
  const res = await db.query('SELECT COUNT(*) as count FROM daily_metrics');
  if (parseInt(res.rows[0].count) === 0) {
    // Seed daily_metrics (30 days)
    let metricsValues = [];
    let baseDate = new Date('2023-10-01T00:00:00Z');
    for (let i = 0; i < 30; i++) {
      let d = new Date(baseDate);
      d.setDate(d.getDate() + i);
      let dateStr = d.toISOString().split('T')[0];
      // Deterministic values
      let visitors = 1000 + (i * 50) + (i % 3 === 0 ? 200 : 0) - (i % 7 === 0 ? 300 : 0);
      let revenue = visitors * 2.5 + (i % 5 === 0 ? 500 : 0);
      metricsValues.push(`('${dateStr}', ${visitors}, ${revenue})`);
    }
    await db.exec(`INSERT INTO daily_metrics (date, visitors, revenue) VALUES ${metricsValues.join(',')}`);

    // Seed categories
    await db.exec(`
      INSERT INTO categories (name, value) VALUES
      ('Enterprise Infrastructure & Compliance', 1250000),
      ('Consumer Electronics', 450000),
      ('Software Subscriptions', 320000),
      ('Consulting Services', 150000),
      ('Hardware Sales', 80000),
      ('Other', 25000)
    `);

    // Seed recent_items
    let itemsValues = [];
    for (let i = 0; i < 20; i++) {
      let d = new Date(baseDate);
      d.setDate(d.getDate() + 29);
      d.setHours(10 + (i % 8), i % 60, 0);
      let dateStr = d.toISOString();
      let val = 100 + (i * 15.5);
      itemsValues.push(`('Item ${i+1}', 'Category ${i%6}', ${val}, '${dateStr}')`);
    }
    await db.exec(`INSERT INTO recent_items (name, category, value, created_at) VALUES ${itemsValues.join(',')}`);

    // Seed settings
    await db.exec(`INSERT INTO settings (key, value) VALUES ('theme', 'light')`);
  }
}

initDb().catch(console.error);

app.get('/api/summary', async (req, res) => {
  try {
    const metrics = await db.query('SELECT * FROM daily_metrics ORDER BY date ASC');
    const rows = metrics.rows;
    if (rows.length === 0) return res.json({ totalVisitors: 0, totalRevenue: 0, bestDay: null, trend: 0 });

    let totalVisitors = 0;
    let totalRevenue = 0;
    let bestDay = rows[0];

    for (let row of rows) {
      totalVisitors += parseInt(row.visitors);
      totalRevenue += parseFloat(row.revenue);
      if (parseFloat(row.revenue) > parseFloat(bestDay.revenue)) {
        bestDay = row;
      }
    }

    // 7-day trend %
    // Compare last 7 days to previous 7 days
    let last7Revenue = 0;
    let prev7Revenue = 0;
    for (let i = rows.length - 7; i < rows.length; i++) {
      last7Revenue += parseFloat(rows[i].revenue);
    }
    for (let i = rows.length - 14; i < rows.length - 7; i++) {
      prev7Revenue += parseFloat(rows[i].revenue);
    }
    let trend = prev7Revenue === 0 ? 0 : ((last7Revenue - prev7Revenue) / prev7Revenue) * 100;

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
    const metrics = await db.query('SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC');
    res.json(metrics.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const cats = await db.query('SELECT name, value FROM categories ORDER BY value DESC');
    res.json(cats.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/recent', async (req, res) => {
  try {
    const items = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20');
    res.json(items.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const settings = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    res.json({ theme: settings.rows.length > 0 ? settings.rows[0].value : 'light' });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});