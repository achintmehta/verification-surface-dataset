const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve static frontend build if it exists
const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(frontendDist));

let db;

async function startServer() {
  db = await initDB();

  // --- API Routes ---

  // GET /api/summary - four headline numbers
  app.get('/api/summary', async (req, res) => {
    try {
      const totalVisitors = await db.query('SELECT COALESCE(SUM(visitors), 0) AS val FROM daily_metrics');
      const totalRevenue = await db.query('SELECT COALESCE(SUM(revenue), 0) AS val FROM daily_metrics');
      const bestDay = await db.query('SELECT date FROM daily_metrics ORDER BY visitors DESC LIMIT 1');
      
      // 7-day trend: compare last 7 days avg to previous 7 days avg
      const trend = await db.query(`
        WITH ranked AS (
          SELECT visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
          FROM daily_metrics
        ),
        recent AS (
          SELECT AVG(visitors) AS avg_val FROM ranked WHERE rn <= 7
        ),
        previous AS (
          SELECT AVG(visitors) AS avg_val FROM ranked WHERE rn > 7 AND rn <= 14
        )
        SELECT 
          CASE WHEN previous.avg_val = 0 THEN 0 
               ELSE ROUND(((recent.avg_val - previous.avg_val) / previous.avg_val * 100)::numeric, 1) 
          END AS trend_pct
        FROM recent, previous
      `);

      res.json({
        totalVisitors: Number(totalVisitors.rows[0].val),
        totalRevenue: Number(totalRevenue.rows[0].val),
        bestDay: bestDay.rows[0]?.date || null,
        trendPct: Number(trend.rows[0]?.trend_pct || 0)
      });
    } catch (err) {
      console.error('Error in /api/summary:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/timeseries
  app.get('/api/timeseries', async (req, res) => {
    try {
      const result = await db.query('SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC');
      res.json(result.rows);
    } catch (err) {
      console.error('Error in /api/timeseries:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/categories
  app.get('/api/categories', async (req, res) => {
    try {
      const result = await db.query('SELECT id, name, value FROM categories ORDER BY value DESC');
      res.json(result.rows);
    } catch (err) {
      console.error('Error in /api/categories:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/recent
  app.get('/api/recent', async (req, res) => {
    try {
      const result = await db.query('SELECT id, name, category, value, created_at FROM recent_items ORDER BY created_at DESC');
      res.json(result.rows);
    } catch (err) {
      console.error('Error in /api/recent:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/settings
  app.get('/api/settings', async (req, res) => {
    try {
      const result = await db.query("SELECT key, value FROM settings WHERE key = 'theme'");
      const theme = result.rows[0]?.value || 'light';
      res.json({ theme });
    } catch (err) {
      console.error('Error in GET /api/settings:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PUT /api/settings
  app.put('/api/settings', async (req, res) => {
    try {
      const { theme } = req.body;
      if (!theme || !['light', 'dark'].includes(theme)) {
        return res.status(400).json({ error: 'Invalid theme. Must be "light" or "dark".' });
      }
      await db.query(
        "UPDATE settings SET value = $1 WHERE key = 'theme'",
        [theme]
      );
      res.json({ theme });
    } catch (err) {
      console.error('Error in PUT /api/settings:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // SPA fallback
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });

  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
