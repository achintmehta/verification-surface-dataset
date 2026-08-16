const express = require('express');
const cors = require('cors');
const { initDB } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

let db;

app.get('/api/summary', async (req, res) => {
  try {
    const result = await db.query(`
      WITH stats AS (
        SELECT 
          SUM(visitors) as total_visitors,
          SUM(revenue) as total_revenue,
          MAX(revenue) as best_day_revenue
        FROM daily_metrics
      ),
      trend AS (
        SELECT 
          (SELECT SUM(visitors) FROM (SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 7) as last7) as last_7_visitors,
          (SELECT SUM(visitors) FROM (SELECT visitors FROM daily_metrics ORDER BY date DESC OFFSET 7 LIMIT 7) as prev7) as prev_7_visitors
      )
      SELECT 
        s.total_visitors,
        s.total_revenue,
        s.best_day_revenue,
        CASE 
          WHEN t.prev_7_visitors = 0 THEN 0 
          ELSE ((t.last_7_visitors - t.prev_7_visitors) * 100.0 / t.prev_7_visitors) 
        END as trend_percent
      FROM stats s, trend t
    `);
    res.json(result.rows[0]);
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

const PORT = process.env.PORT || 3000;

initDB().then(database => {
  db = database;
  app.listen(PORT, () => {
    console.log(\`Backend listening on port \${PORT}\`);
  });
}).catch(err => {
  console.error('Failed to initialize DB', err);
  process.exit(1);
});