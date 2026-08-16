import express from 'express';
import cors from 'cors';
import { db, initDb } from './db.js';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/summary', async (req, res) => {
  try {
    const metrics = await db.query(`SELECT * FROM daily_metrics ORDER BY date ASC`);
    const rows = metrics.rows;
    
    let totalVisitors = 0;
    let totalRevenue = 0;
    let bestDayRevenue = 0;
    
    rows.forEach(r => {
      totalVisitors += r.visitors;
      let rev = parseFloat(r.revenue);
      totalRevenue += rev;
      if (rev > bestDayRevenue) bestDayRevenue = rev;
    });

    let last7Revenue = 0;
    let prev7Revenue = 0;
    if (rows.length >= 14) {
      for (let i = rows.length - 7; i < rows.length; i++) {
        last7Revenue += parseFloat(rows[i].revenue);
      }
      for (let i = rows.length - 14; i < rows.length - 7; i++) {
        prev7Revenue += parseFloat(rows[i].revenue);
      }
    }
    let trend = 0;
    if (prev7Revenue > 0) {
      trend = ((last7Revenue - prev7Revenue) / prev7Revenue) * 100;
    }

    res.json({
      totalVisitors,
      totalRevenue,
      bestDayRevenue,
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
    const settings = await db.query(`SELECT key, value FROM settings WHERE key = 'theme'`);
    if (settings.rows.length > 0) {
      res.json({ theme: settings.rows[0].value });
    } else {
      res.json({ theme: 'light' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const { theme } = req.body;
    if (theme === 'light' || theme === 'dark') {
      await db.query(`UPDATE settings SET value = $1 WHERE key = 'theme'`, [theme]);
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'Invalid theme' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Backend listening on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize DB', err);
});