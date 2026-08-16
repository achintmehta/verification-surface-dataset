import express from 'express';
import cors from 'cors';
import db, { initDb } from './db.js';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/summary', async (req, res) => {
  try {
    const metricsRes = await db.query(`SELECT * FROM daily_metrics ORDER BY date ASC`);
    const rows = metricsRes.rows;
    
    let totalVisitors = 0;
    let totalRevenue = 0;
    let bestDayRevenue = 0;
    let bestDayDate = '';
    
    rows.forEach(r => {
      totalVisitors += r.visitors;
      const rev = parseFloat(r.revenue);
      totalRevenue += rev;
      if (rev > bestDayRevenue) {
        bestDayRevenue = rev;
        bestDayDate = r.date;
      }
    });

    const last7 = rows.slice(-7);
    const prev7 = rows.slice(-14, -7);
    
    const revLast7 = last7.reduce((sum, r) => sum + parseFloat(r.revenue), 0);
    const revPrev7 = prev7.reduce((sum, r) => sum + parseFloat(r.revenue), 0);
    
    let trend = 0;
    if (revPrev7 > 0) {
      trend = ((revLast7 - revPrev7) / revPrev7) * 100;
    }

    res.json({
      totalVisitors,
      totalRevenue,
      bestDay: { date: bestDayDate, revenue: bestDayRevenue },
      trendPercent: trend
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/timeseries', async (req, res) => {
  try {
    const result = await db.query(`SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC`);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const result = await db.query(`SELECT name, value FROM categories ORDER BY value DESC`);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/recent', async (req, res) => {
  try {
    const result = await db.query(`SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const result = await db.query(`SELECT value FROM settings WHERE key = 'theme'`);
    if (result.rows.length > 0) {
      res.json({ theme: result.rows[0].value });
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

initDb().then(() => {
  app.listen(3000, () => {
    console.log('Backend listening on port 3000');
  });
}).catch(err => {
  console.error('Failed to initialize DB', err);
});