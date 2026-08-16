const express = require('express');
const cors = require('cors');
const { initDB } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

let db;

app.get('/api/summary', async (req, res) => {
  try {
    const resVisitors = await db.query('SELECT SUM(visitors) as total_visitors FROM daily_metrics');
    const resRevenue = await db.query('SELECT SUM(revenue) as total_revenue FROM daily_metrics');
    const resBestDay = await db.query('SELECT date, revenue FROM daily_metrics ORDER BY revenue DESC LIMIT 1');
    
    const resLast7 = await db.query('SELECT SUM(revenue) as rev FROM (SELECT revenue FROM daily_metrics ORDER BY date DESC LIMIT 7) sub');
    const resPrev7 = await db.query('SELECT SUM(revenue) as rev FROM (SELECT revenue FROM daily_metrics ORDER BY date DESC OFFSET 7 LIMIT 7) sub');
    
    const last7 = parseFloat(resLast7.rows[0].rev || 0);
    const prev7 = parseFloat(resPrev7.rows[0].rev || 0);
    const trend = prev7 > 0 ? ((last7 - prev7) / prev7) * 100 : 0;

    res.json({
      total_visitors: parseInt(resVisitors.rows[0].total_visitors || 0),
      total_revenue: parseFloat(resRevenue.rows[0].total_revenue || 0),
      best_day_revenue: parseFloat(resBestDay.rows[0].revenue || 0),
      best_day_date: resBestDay.rows[0].date,
      trend_percent: trend
    });
  } catch (err) {
    console.error('Summary error:', err);
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
    const result = await db.query('SELECT theme FROM settings LIMIT 1');
    res.json(result.rows[0] || { theme: 'light' });
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
    await db.query('UPDATE settings SET theme = $1', [theme]);
    res.json({ theme });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = 3001;
initDB().then(database => {
  db = database;
  app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
  });
});
