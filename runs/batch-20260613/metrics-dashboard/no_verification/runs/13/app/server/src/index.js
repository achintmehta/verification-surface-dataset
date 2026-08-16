import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Helper to wrap async route handlers and forward errors.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/api/health', (req, res) => res.json({ ok: true }));

/**
 * GET /api/summary
 * Returns the four headline numbers:
 *  - totalVisitors  : sum of visitors over the 30 days
 *  - totalRevenue   : sum of revenue over the 30 days
 *  - bestDay        : { day, visitors } with the most visitors
 *  - trendPct       : % change of last 7 days vs the prior 7 days (by revenue)
 */
app.get(
  '/api/summary',
  wrap(async (req, res) => {
    const db = await getDb();

    const totals = await db.query(
      'SELECT COALESCE(SUM(visitors),0)::bigint AS visitors, COALESCE(SUM(revenue),0)::numeric AS revenue FROM daily_metrics'
    );

    const best = await db.query(
      'SELECT day, visitors FROM daily_metrics ORDER BY visitors DESC, day DESC LIMIT 1'
    );

    // 7-day trend: last 7 days revenue vs the 7 days before that.
    const series = await db.query(
      'SELECT revenue FROM daily_metrics ORDER BY day ASC'
    );
    const revenues = series.rows.map((r) => Number(r.revenue));
    const n = revenues.length;
    const last7 = revenues.slice(Math.max(0, n - 7)).reduce((a, b) => a + b, 0);
    const prev7 = revenues
      .slice(Math.max(0, n - 14), Math.max(0, n - 7))
      .reduce((a, b) => a + b, 0);
    let trendPct = 0;
    if (prev7 > 0) trendPct = ((last7 - prev7) / prev7) * 100;

    res.json({
      totalVisitors: Number(totals.rows[0].visitors),
      totalRevenue: Number(totals.rows[0].revenue),
      bestDay: best.rows[0]
        ? { day: best.rows[0].day, visitors: best.rows[0].visitors }
        : null,
      trendPct: +trendPct.toFixed(1),
    });
  })
);

/** GET /api/timeseries — 30 days of {day, visitors, revenue} ascending. */
app.get(
  '/api/timeseries',
  wrap(async (req, res) => {
    const db = await getDb();
    const result = await db.query(
      'SELECT day, visitors, revenue FROM daily_metrics ORDER BY day ASC'
    );
    res.json(
      result.rows.map((r) => ({
        day: r.day,
        visitors: Number(r.visitors),
        revenue: Number(r.revenue),
      }))
    );
  })
);

/** GET /api/categories — 6 categories {name, value} descending by value. */
app.get(
  '/api/categories',
  wrap(async (req, res) => {
    const db = await getDb();
    const result = await db.query(
      'SELECT name, value FROM categories ORDER BY value DESC'
    );
    res.json(result.rows.map((r) => ({ name: r.name, value: Number(r.value) })));
  })
);

/** GET /api/recent — 20 recent items, newest first. */
app.get(
  '/api/recent',
  wrap(async (req, res) => {
    const db = await getDb();
    const result = await db.query(
      'SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC'
    );
    res.json(
      result.rows.map((r) => ({
        name: r.name,
        category: r.category,
        value: Number(r.value),
        createdAt: r.created_at,
      }))
    );
  })
);

/** GET /api/settings — { theme } */
app.get(
  '/api/settings',
  wrap(async (req, res) => {
    const db = await getDb();
    const result = await db.query('SELECT theme FROM settings WHERE id = 1');
    const theme = result.rows[0]?.theme ?? 'light';
    res.json({ theme });
  })
);

/** PUT /api/settings — persists { theme: 'light' | 'dark' } */
app.put(
  '/api/settings',
  wrap(async (req, res) => {
    const { theme } = req.body || {};
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
  })
);

// Generic error handler.
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

getDb()
  .then(() => {
    app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`Metrics dashboard API listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
