const express = require('express');
const cors = require('cors');
const { db, initDb } = require('./db');

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
    
    rows.forEach(r => {
      totalVisitors += r.visitors;
      let rev = parseFloat(r.revenue);
      totalRevenue += rev;
      if (rev > bestDayRevenue) bestDayRevenue = rev;
    });

    // 7-day trend %
    // Compare last 7 days to previous 7 days
    let last7Rev = 0;
    let prev7Rev = 0;
    if (rows.length >= 14) {
      for (let i = rows.length - 7; i < rows.length; i++) {
        last7Rev += parseFloat(rows[i].revenue);
      }
      for (let i = rows.length - 14; i < rows.length - 7; i++) {
        prev7Rev += parseFloat(rows[i].revenue);
      }
    }
    let trend = 0;
    if (prev7Rev > 0) {
      trend = ((last7Rev - prev7Rev) / prev7Rev) * 100;
    }

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
    const metricsRes = await db.query(`SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC`);
    res.json(metricsRes.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const catRes = await db.query(`SELECT name, value FROM categories ORDER BY value DESC`);
    res.json(catRes.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/recent', async (req, res) => {
  try {
    const recentRes = await db.query(`SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20`);
    res.json(recentRes.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const setRes = await db.query(`SELECT value FROM settings WHERE key = 'theme'`);
    if (setRes.rows.length > 0) {
      res.json({ theme: setRes.rows[0].value });
    } else {
      res.json({ theme: 'light' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Backend listening on port ${PORT}`);
  });
}).catch(err => {
  console.error("Failed to initialize DB", err);
});