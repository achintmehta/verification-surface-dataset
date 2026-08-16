const express = require('express');
const cors = require('cors');
const { getDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ─── GET /api/summary ───────────────────────────────────────────────
// Returns: { totalVisitors, totalRevenue, bestDay, trend7d }
app.get('/api/summary', async (req, res) => {
  try {
    const db = await getDb();

    const totals = await db.query(`
      SELECT
        SUM(visitors)::bigint AS total_visitors,
        SUM(revenue)::numeric AS total_revenue
      FROM daily_metrics
    `);

    const best = await db.query(`
      SELECT date FROM daily_metrics ORDER BY visitors DESC LIMIT 1
    `);

    // 7-day trend: compare last 7 days average to previous 7 days average
    const allRows = await db.query(`
      SELECT visitors FROM daily_metrics ORDER BY date DESC
    `);
    const rows = allRows.rows;
    const last7 = rows.slice(0, 7).reduce((s, r) => s + Number(r.visitors), 0) / 7;
    const prev7 = rows.slice(7, 14).reduce((s, r) => s + Number(r.visitors), 0) / 7;
    const trendPct = prev7 > 0 ? (((last7 - prev7) / prev7) * 100) : 0;

    res.json({
      totalVisitors: Number(totals.rows[0].total_visitors),
      totalRevenue: parseFloat(Number(totals.rows[0].total_revenue).toFixed(2)),
      bestDay: best.rows[0].date,
      trend7d: parseFloat(trendPct.toFixed(1))
    });
  } catch (err) {
    console.error('Error in /api/summary:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/timeseries ────────────────────────────────────────────
app.get('/api/timeseries', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(
      'SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC'
    );
    res.json(result.rows.map(r => ({
      date: r.date,
      visitors: Number(r.visitors),
      revenue: parseFloat(Number(r.revenue).toFixed(2))
    })));
  } catch (err) {
    console.error('Error in /api/timeseries:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/categories ───────────────────────────────────────────
app.get('/api/categories', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(
      'SELECT name, value FROM categories ORDER BY value DESC'
    );
    res.json(result.rows.map(r => ({
      name: r.name,
      value: Number(r.value)
    })));
  } catch (err) {
    console.error('Error in /api/categories:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/recent ────────────────────────────────────────────────
app.get('/api/recent', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(
      'SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC'
    );
    res.json(result.rows.map(r => ({
      name: r.name,
      category: r.category,
      value: Number(r.value),
      created_at: r.created_at
    })));
  } catch (err) {
    console.error('Error in /api/recent:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/settings ─────────────────────────────────────────────
app.get('/api/settings', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    const theme = result.rows.length > 0 ? result.rows[0].value : 'light';
    res.json({ theme });
  } catch (err) {
    console.error('Error in GET /api/settings:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PUT /api/settings ─────────────────────────────────────────────
app.put('/api/settings', async (req, res) => {
  try {
    const { theme } = req.body;
    if (!theme || !['light', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    const db = await getDb();

    // Upsert
    const exists = await db.query("SELECT 1 FROM settings WHERE key = 'theme'");
    if (exists.rows.length > 0) {
      await db.query("UPDATE settings SET value = $1 WHERE key = 'theme'", [theme]);
    } else {
      await db.query("INSERT INTO settings (key, value) VALUES ('theme', $1)", [theme]);
    }

    res.json({ theme });
  } catch (err) {
    console.error('Error in PUT /api/settings:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
