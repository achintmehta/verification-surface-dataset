import express from 'express';
import cors from 'cors';
import { db, initDb } from './db.js';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/summary', async (req, res) => {
  try {
    const totalRes = await db.query('SELECT SUM(visitors) as total_visitors, SUM(revenue) as total_revenue FROM daily_metrics');
    const bestDayRes = await db.query('SELECT date, revenue FROM daily_metrics ORDER BY revenue DESC LIMIT 1');
    
    const metricsRes = await db.query('SELECT revenue FROM daily_metrics ORDER BY date ASC');
    const revenues = metricsRes.rows.map(r => parseFloat(r.revenue));
    
    let last7 = 0;
    let prev7 = 0;
    if (revenues.length >= 14) {
      last7 = revenues.slice(-7).reduce((a, b) => a + b, 0);
      prev7 = revenues.slice(-14, -7).reduce((a, b) => a + b, 0);
    }
    
    let trend = 0;
    if (prev7 > 0) {
      trend = ((last7 - prev7) / prev7) * 100;
    }

    res.json({
      totalVisitors: parseInt(totalRes.rows[0].total_visitors),
      totalRevenue: parseFloat(totalRes.rows[0].total_revenue),
      bestDay: bestDayRes.rows[0].date,
      bestDayRevenue: parseFloat(bestDayRes.rows[0].revenue),
      trendPercent: trend
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
    const result = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC');
    res.json(result.rows);
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
    if (theme !== 'light' && theme !== 'dark') {
      return res.status(400).json({ error: 'Invalid theme' });
    }
    await db.query("INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [theme]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(\`Backend listening on port \${PORT}\`);
  });
}).catch(err => {
  console.error('Failed to initialize database', err);
  process.exit(1);
});
