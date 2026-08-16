import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';

const app = express();
const PORT = process.env.PORT || 4000;

/** Normalize a PGlite date/value to an ISO YYYY-MM-DD string. */
function toISODate(v) {
  if (v instanceof Date) {
    return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()))
      .toISOString()
      .slice(0, 10);
  }
  return String(v).slice(0, 10);
}

app.use(cors());
app.use(express.json());

// --- Summary: four headline numbers ---
app.get('/api/summary', async (req, res, next) => {
  try {
    const db = await getDb();
    const totals = await db.query(
      `SELECT COALESCE(SUM(visitors),0)::bigint AS total_visitors,
              COALESCE(SUM(revenue),0)::numeric AS total_revenue
       FROM daily_metrics`
    );
    const best = await db.query(
      `SELECT day, visitors FROM daily_metrics ORDER BY visitors DESC, day DESC LIMIT 1`
    );
    // 7-day trend: sum of last 7 days vs the previous 7 days (by visitors).
    const ordered = await db.query(
      `SELECT day, visitors FROM daily_metrics ORDER BY day DESC LIMIT 14`
    );
    const last14 = ordered.rows;
    const last7 = last14.slice(0, 7).reduce((a, r) => a + Number(r.visitors), 0);
    const prev7 = last14.slice(7, 14).reduce((a, r) => a + Number(r.visitors), 0);
    let trend = 0;
    if (prev7 > 0) trend = ((last7 - prev7) / prev7) * 100;

    const bestRow = best.rows[0] || null;
    res.json({
      totalVisitors: Number(totals.rows[0].total_visitors),
      totalRevenue: Number(totals.rows[0].total_revenue),
      bestDay: bestRow
        ? { day: toISODate(bestRow.day), visitors: Number(bestRow.visitors) }
        : null,
      trend7d: +trend.toFixed(1),
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/timeseries', async (req, res, next) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(
      `SELECT day, visitors, revenue FROM daily_metrics ORDER BY day ASC`
    );
    res.json(
      rows.map((r) => ({
        day: toISODate(r.day),
        visitors: Number(r.visitors),
        revenue: Number(r.revenue),
      }))
    );
  } catch (err) {
    next(err);
  }
});

app.get('/api/categories', async (req, res, next) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(
      `SELECT name, value FROM categories ORDER BY value DESC`
    );
    res.json(rows.map((r) => ({ name: r.name, value: Number(r.value) })));
  } catch (err) {
    next(err);
  }
});

app.get('/api/recent', async (req, res, next) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(
      `SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC`
    );
    res.json(
      rows.map((r) => ({
        name: r.name,
        category: r.category,
        value: Number(r.value),
        createdAt: new Date(r.created_at).toISOString(),
      }))
    );
  } catch (err) {
    next(err);
  }
});

app.get('/api/settings', async (req, res, next) => {
  try {
    const db = await getDb();
    const { rows } = await db.query('SELECT theme FROM settings WHERE id = 1');
    res.json({ theme: rows[0] ? rows[0].theme : 'light' });
  } catch (err) {
    next(err);
  }
});

app.put('/api/settings', async (req, res, next) => {
  try {
    const theme = req.body && req.body.theme;
    if (theme !== 'light' && theme !== 'dark') {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    const db = await getDb();
    await db.query(
      `INSERT INTO settings (id, theme) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET theme = EXCLUDED.theme`,
      [theme]
    );
    res.json({ theme });
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

getDb()
  .then(() => {
    app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`Metrics API listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to initialize database', err);
    process.exit(1);
  });
