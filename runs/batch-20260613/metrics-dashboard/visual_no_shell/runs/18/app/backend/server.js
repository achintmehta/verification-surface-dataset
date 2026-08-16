const express = require('express');
const cors = require('cors');
const { db, initDb } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/summary', async (req, res) => {
  try {
    const visitorsRes = await db.query('SELECT SUM(visitors) as total_visitors FROM daily_metrics');
    const revenueRes = await db.query('SELECT SUM(revenue) as total_revenue FROM daily_metrics');
    const bestDayRes = await db.query('SELECT date, revenue FROM daily_metrics ORDER BY revenue DESC LIMIT 1');
    
    const last14Res = await db.query('SELECT date, revenue FROM daily_metrics ORDER BY date DESC LIMIT 14');
    const last14 = last14Res.rows;
    let last7Revenue = 0;
    let prev7Revenue = 0;
    for (let i = 0; i < 7; i++) {
      if (last14[i]) last7Revenue += parseFloat(last14[i].revenue);
      if (last14[i + 7]) prev7Revenue += parseFloat(last14[i + 7].revenue);
    }
    let trend = 0;
    if (prev7Revenue > 0) {
      trend = ((last7Revenue - prev7Revenue) / prev7Revenue) * 100;
    }

    res.json({
      totalVisitors: parseInt(visitorsRes.rows[0].total_visitors),
      totalRevenue: parseFloat(revenueRes.rows[0].total_revenue),
      bestDay: bestDayRes.rows[0].date.toISOString().split('T')[0],
      bestDayRevenue: parseFloat(bestDayRes.rows[0].revenue),
      trend7Day: trend
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/timeseries', async (req, res) => {
  try {
    const result = await db.query('SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC');
    res.json(result.rows.map(r => ({
      date: r.date.toISOString().split('T')[0],
      visitors: parseInt(r.visitors),
      revenue: parseFloat(r.revenue)
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const result = await db.query('SELECT name, value FROM categories ORDER BY value DESC');
    res.json(result.rows.map(r => ({
      name: r.name,
      value: parseFloat(r.value)
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/recent', async (req, res) => {
  try {
    const result = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20');
    res.json(result.rows.map(r => ({
      name: r.name,
      category: r.category,
      value: parseFloat(r.value),
      created_at: r.created_at.toISOString()
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const result = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    res.json({ theme: result.rows.length > 0 ? result.rows[0].value : 'light' });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize DB', err);
  process.exit(1);
});
