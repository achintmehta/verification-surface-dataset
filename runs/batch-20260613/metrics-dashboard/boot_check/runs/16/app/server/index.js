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
    
    for (const row of rows) {
      totalVisitors += parseInt(row.visitors);
      const rev = parseFloat(row.revenue);
      totalRevenue += rev;
      if (rev > bestDayRevenue) bestDayRevenue = rev;
    }

    const last7 = rows.slice(-7).reduce((sum, r) => sum + parseFloat(r.revenue), 0);
    const prev7 = rows.slice(-14, -7).reduce((sum, r) => sum + parseFloat(r.revenue), 0);
    const trend = prev7 === 0 ? 0 : ((last7 - prev7) / prev7) * 100;

    res.json({
      totalVisitors,
      totalRevenue,
      bestDayRevenue,
      trend: trend.toFixed(1)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/timeseries', async (req, res) => {
  try {
    const result = await db.query(`SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const result = await db.query(`SELECT name, value FROM categories ORDER BY value DESC`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/recent', async (req, res) => {
  try {
    const result = await db.query(`SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const result = await db.query(`SELECT theme FROM settings WHERE id = 1`);
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
    await db.query(`UPDATE settings SET theme = $1 WHERE id = 1`, [theme]);
    res.json({ theme });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database', err);
  process.exit(1);
});