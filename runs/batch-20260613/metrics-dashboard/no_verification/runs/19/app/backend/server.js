const express = require('express');
const cors = require('cors');
const { db, initDb } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/summary', async (req, res) => {
  try {
    const metricsRes = await db.query('SELECT * FROM daily_metrics ORDER BY date ASC');
    const rows = metricsRes.rows;
    
    let totalVisitors = 0;
    let totalRevenue = 0;
    let bestDayRevenue = 0;
    let bestDayDate = '';
    
    rows.forEach(row => {
      totalVisitors += row.visitors;
      const rev = parseFloat(row.revenue);
      totalRevenue += rev;
      if (rev > bestDayRevenue) {
        bestDayRevenue = rev;
        bestDayDate = row.date;
      }
    });

    // 7-day trend % (last 7 days vs previous 7 days revenue)
    const last7 = rows.slice(-7);
    const prev7 = rows.slice(-14, -7);
    
    const last7Rev = last7.reduce((sum, r) => sum + parseFloat(r.revenue), 0);
    const prev7Rev = prev7.reduce((sum, r) => sum + parseFloat(r.revenue), 0);
    
    let trendPercent = 0;
    if (prev7Rev > 0) {
      trendPercent = ((last7Rev - prev7Rev) / prev7Rev) * 100;
    }

    res.json({
      totalVisitors,
      totalRevenue,
      bestDay: { date: bestDayDate, revenue: bestDayRevenue },
      trendPercent: trendPercent.toFixed(2)
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
    const result = await db.query("SELECT value FROM settings WHERE key = 'theme'");
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
    await db.query("UPDATE settings SET value = $1 WHERE key = 'theme'", [theme]);
    res.json({ success: true, theme });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(\`Backend listening on port \${PORT}\`);
  });
}).catch(err => {
  console.error('Failed to initialize database', err);
});
