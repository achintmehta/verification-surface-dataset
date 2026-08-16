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

  // GET /api/summary
  app.get('/api/summary', async (req, res) => {
    try {
      const totalVisitors = await db.query('SELECT SUM(visitors)::int AS val FROM daily_metrics');
      const totalRevenue = await db.query('SELECT SUM(revenue)::numeric AS val FROM daily_metrics');
      const bestDay = await db.query('SELECT date FROM daily_metrics ORDER BY visitors DESC LIMIT 1');
      
      // 7-day trend: compare last 7 days avg to previous 7 days avg
      const trend = await db.query(`
        WITH ranked AS (
          SELECT visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
          FROM daily_metrics
        )
        SELECT
          COALESCE(AVG(CASE WHEN rn <= 7 THEN visitors END), 0) AS recent_avg,
          COALESCE(AVG(CASE WHEN rn > 7 AND rn <= 14 THEN visitors END), 0) AS prev_avg
        FROM ranked
      `);

      const recentAvg = parseFloat(trend.rows[0].recent_avg);
      const prevAvg = parseFloat(trend.rows[0].prev_avg);
      const trendPct = prevAvg === 0 ? 0 : ((recentAvg - prevAvg) / prevAvg * 100);

      res.json({
        totalVisitors: totalVisitors.rows[0].val,
        totalRevenue: parseFloat(totalRevenue.rows[0].val),
        bestDay: bestDay.rows[0].date,
        trendPct: Math.round(trendPct * 10) / 10
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
      res.json(result.rows.map(r => ({
        date: r.date,
        visitors: r.visitors,
        revenue: parseFloat(r.revenue)
      })));
    } catch (err) {
      console.error('Error in /api/timeseries:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/categories
  app.get('/api/categories', async (req, res) => {
    try {
      const result = await db.query('SELECT id, name, value FROM categories ORDER BY value DESC');
      res.json(result.rows.map(r => ({
        id: r.id,
        name: r.name,
        value: r.value
      })));
    } catch (err) {
      console.error('Error in /api/categories:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/recent
  app.get('/api/recent', async (req, res) => {
    try {
      const result = await db.query('SELECT id, name, category, value, created_at FROM recent_items ORDER BY created_at DESC');
      res.json(result.rows.map(r => ({
        id: r.id,
        name: r.name,
        category: r.category,
        value: r.value,
        createdAt: r.created_at
      })));
    } catch (err) {
      console.error('Error in /api/recent:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/settings
  app.get('/api/settings', async (req, res) => {
    try {
      const result = await db.query("SELECT value FROM settings WHERE key = 'theme'");
      const theme = result.rows.length > 0 ? result.rows[0].value : 'light';
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
      if (theme !== 'light' && theme !== 'dark') {
        return res.status(400).json({ error: 'Theme must be "light" or "dark"' });
      }
      await db.query(
        "INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
        [theme]
      );
      res.json({ theme });
    } catch (err) {
      console.error('Error in PUT /api/settings:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Fallback: serve index.html for SPA
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
