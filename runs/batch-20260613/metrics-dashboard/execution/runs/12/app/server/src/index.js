import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * GET /api/summary
 * The four headline numbers:
 *  - total visitors (sum over 30 days)
 *  - total revenue (sum over 30 days)
 *  - best day (date + visitors of the highest-visitor day)
 *  - 7-day trend % (last 7 days vs the previous 7 days, by visitors)
 */
app.get(
  '/api/summary',
  asyncHandler(async (req, res) => {
    const db = await getDb();

    const totals = await db.query(
      'SELECT COALESCE(SUM(visitors),0)::bigint AS visitors, COALESCE(SUM(revenue),0)::bigint AS revenue FROM daily_metrics'
    );
    const best = await db.query(
      'SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC, date DESC LIMIT 1'
    );

    const ordered = await db.query(
      'SELECT visitors FROM daily_metrics ORDER BY date ASC'
    );
    const visitorsByDay = ordered.rows.map((r) => Number(r.visitors));
    const last7 = visitorsByDay.slice(-7);
    const prev7 = visitorsByDay.slice(-14, -7);
    const sum = (arr) => arr.reduce((a, b) => a + b, 0);
    const last7Sum = sum(last7);
    const prev7Sum = sum(prev7);
    const trendPct =
      prev7Sum === 0 ? 0 : ((last7Sum - prev7Sum) / prev7Sum) * 100;

    res.json({
      totalVisitors: Number(totals.rows[0].visitors),
      totalRevenue: Number(totals.rows[0].revenue),
      bestDay: best.rows[0]
        ? { date: ymd(best.rows[0].date), visitors: Number(best.rows[0].visitors) }
        : null,
      trendPct: Math.round(trendPct * 10) / 10,
    });
  })
);

app.get(
  '/api/timeseries',
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const result = await db.query(
      'SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC'
    );
    res.json(
      result.rows.map((r) => ({
        date: ymd(r.date),
        visitors: Number(r.visitors),
        revenue: Number(r.revenue),
      }))
    );
  })
);

app.get(
  '/api/categories',
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const result = await db.query(
      'SELECT name, value FROM categories ORDER BY value DESC'
    );
    res.json(result.rows.map((r) => ({ name: r.name, value: Number(r.value) })));
  })
);

app.get(
  '/api/recent',
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const result = await db.query(
      'SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20'
    );
    res.json(
      result.rows.map((r) => ({
        name: r.name,
        category: r.category,
        value: Number(r.value),
        createdAt: new Date(r.created_at).toISOString(),
      }))
    );
  })
);

app.get(
  '/api/settings',
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const result = await db.query(
      "SELECT value FROM settings WHERE key = 'theme'"
    );
    const theme = result.rows[0]?.value === 'dark' ? 'dark' : 'light';
    res.json({ theme });
  })
);

app.put(
  '/api/settings',
  asyncHandler(async (req, res) => {
    const theme = req.body?.theme;
    if (theme !== 'light' && theme !== 'dark') {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    const db = await getDb();
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('theme', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [theme]
    );
    res.json({ theme });
  })
);

// Centralized error handler.
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

function ymd(value) {
  // PGLite returns DATE columns as JS Date objects (UTC midnight).
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

// Warm up the DB (and seed) before accepting traffic so the first request
// isn't slowed by initialization.
getDb()
  .then(() => {
    app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`metrics-dashboard server listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to initialize database', err);
    process.exit(1);
  });
