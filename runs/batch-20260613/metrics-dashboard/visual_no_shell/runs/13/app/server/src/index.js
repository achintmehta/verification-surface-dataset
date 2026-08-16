import express from 'express';
import cors from 'cors';
import { db, initDb } from './db.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// --- Summary: four headline numbers ---
app.get('/api/summary', async (_req, res) => {
  try {
    const totals = await db.query(
      'SELECT COALESCE(SUM(visitors),0)::bigint AS visitors, COALESCE(SUM(revenue),0)::numeric AS revenue FROM daily_metrics'
    );
    const best = await db.query(
      'SELECT day, visitors FROM daily_metrics ORDER BY visitors DESC, day ASC LIMIT 1'
    );

    // 7-day trend %: sum of visitors in last 7 days vs the previous 7 days.
    const recent = await db.query(`
      WITH ordered AS (
        SELECT visitors, ROW_NUMBER() OVER (ORDER BY day DESC) AS rn
        FROM daily_metrics
      )
      SELECT
        COALESCE(SUM(visitors) FILTER (WHERE rn <= 7), 0)::numeric AS last7,
        COALESCE(SUM(visitors) FILTER (WHERE rn > 7 AND rn <= 14), 0)::numeric AS prev7
      FROM ordered
    `);
    const last7 = Number(recent.rows[0].last7);
    const prev7 = Number(recent.rows[0].prev7);
    const trendPct = prev7 === 0 ? 0 : ((last7 - prev7) / prev7) * 100;

    res.json({
      totalVisitors: Number(totals.rows[0].visitors),
      totalRevenue: Number(totals.rows[0].revenue),
      bestDay: best.rows[0]
        ? { day: best.rows[0].day, visitors: Number(best.rows[0].visitors) }
        : null,
      trendPct: +trendPct.toFixed(1)
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Time series: 30 days ---
app.get('/api/timeseries', async (_req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT day, visitors, revenue::float8 AS revenue FROM daily_metrics ORDER BY day ASC'
    );
    res.json(
      rows.map((r) => ({
        day: typeof r.day === 'string' ? r.day : new Date(r.day).toISOString().slice(0, 10),
        visitors: Number(r.visitors),
        revenue: Number(r.revenue)
      }))
    );
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Categories ---
app.get('/api/categories', async (_req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, name, value::bigint AS value FROM categories ORDER BY value DESC'
    );
    res.json(rows.map((r) => ({ id: r.id, name: r.name, value: Number(r.value) })));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Recent items ---
app.get('/api/recent', async (_req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, name, category, value::float8 AS value, created_at FROM recent_items ORDER BY created_at DESC'
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        value: Number(r.value),
        created_at: r.created_at
      }))
    );
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Settings (theme) ---
app.get('/api/settings', async (_req, res) => {
  try {
    const { rows } = await db.query('SELECT theme FROM settings WHERE id = 1');
    res.json({ theme: rows[0] ? rows[0].theme : 'light' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const theme = req.body && req.body.theme;
    if (theme !== 'light' && theme !== 'dark') {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    await db.query(
      `INSERT INTO settings (id, theme) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET theme = EXCLUDED.theme`,
      [theme]
    );
    res.json({ theme });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Metrics dashboard API listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
