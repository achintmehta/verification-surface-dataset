const express = require('express');
const cors = require('cors');
const { getDb, initDb } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/summary', async (req, res) => {
  try {
    const db = getDb();
    const { rows: totals } = await db.query('SELECT SUM(visitors) as total_visitors, SUM(revenue) as total_revenue FROM daily_metrics');
    const { rows: bestDay } = await db.query('SELECT date, revenue FROM daily_metrics ORDER BY revenue DESC LIMIT 1');
    
    const { rows: last7 } = await db.query("SELECT SUM(revenue) as rev FROM daily_metrics WHERE date >= (SELECT MAX(date) - INTERVAL '6 days' FROM daily_metrics)");
    const { rows: prev7 } = await db.query("SELECT SUM(revenue) as rev FROM daily_metrics WHERE date >= (SELECT MAX(date) - INTERVAL '13 days' FROM daily_metrics) AND date < (SELECT MAX(date) - INTERVAL '6 days' FROM daily_metrics)");
    
    const revLast7 = parseFloat(last7[0].rev || 0);
    const revPrev7 = parseFloat(prev7[0].rev || 0);
    const trend = revPrev7 === 0 ? 0 : ((revLast7 - revPrev7) / revPrev7) * 100;

    res.json({
      totalVisitors: parseInt(totals[0].total_visitors || 0),
      totalRevenue: parseFloat(totals[0].total_revenue || 0),
      bestDay: bestDay[0] ? (bestDay[0].date instanceof Date ? bestDay[0].date.toISOString().split('T')[0] : bestDay[0].date) : null,
      trendPercent: trend
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/timeseries', async (req, res) => {
  try {
    const db = getDb();
    const { rows } = await db.query('SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC');
    res.json(rows.map(r => ({
      date: r.date instanceof Date ? r.date.toISOString().split('T')[0] : r.date,
      visitors: parseInt(r.visitors),
      revenue: parseFloat(r.revenue)
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const db = getDb();
    const { rows } = await db.query('SELECT name, value FROM categories ORDER BY value DESC');
    res.json(rows.map(r => ({
      name: r.name,
      value: parseFloat(r.value)
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/recent', async (req, res) => {
  try {
    const db = getDb();
    const { rows } = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC');
    res.json(rows.map(r => ({
      name: r.name,
      category: r.category,
      value: parseFloat(r.value),
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const db = getDb();
    const { rows } = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    res.json({ theme: rows[0] ? rows[0].value : 'light' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const db = getDb();
    const { theme } = req.body;
    if (theme === 'light' || theme === 'dark') {
      await db.query("UPDATE settings SET value = $1 WHERE key = 'theme'", [theme]);
      res.json({ theme });
    } else {
      res.status(400).json({ error: 'Invalid theme' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = 3001;
initDb().then(() => {
  app.listen(PORT, () => {
    console.log("Backend running on port " + PORT);
  });
}).catch(err => {
  console.error('Failed to initialize DB', err);
});
