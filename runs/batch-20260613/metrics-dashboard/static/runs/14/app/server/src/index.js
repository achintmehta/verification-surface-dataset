import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/**
 * GET /api/summary
 * Returns total visitors, total revenue, best day (by visitors),
 * and the 7-day trend percentage (last 7 days vs the prior 7 days).
 */
app.get(
  '/api/summary',
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const totals = await db.query(
      `SELECT COALESCE(SUM(visitors), 0)::bigint AS total_visitors,
              COALESCE(SUM(revenue), 0)::numeric AS total_revenue
         FROM daily_metrics`
    );
    const best = await db.query(
      `SELECT date, visitors
         FROM daily_metrics
        ORDER BY visitors DESC, date DESC
        LIMIT 1`
    );
    // 7-day trend: sum of last 7 days vs the 7 days before that, by visitors.
    const trendRows = await db.query(
      `SELECT date, visitors
         FROM daily_metrics
        ORDER BY date DESC
        LIMIT 14`
    );
    const series = trendRows.rows.map((r) => Number(r.visitors));
    const last7 = series.slice(0, 7).reduce((a, b) => a + b, 0);
    const prev7 = series.slice(7, 14).reduce((a, b) => a + b, 0);
    const trendPct =
      prev7 > 0 ? Math.round(((last7 - prev7) / prev7) * 1000) / 10 : 0;

    res.json({
      totalVisitors: Number(totals.rows[0].total_visitors),
      totalRevenue: Number(totals.rows[0].total_revenue),
      bestDay: best.rows[0]
        ? {
            date:
              typeof best.rows[0].date === 'string'
                ? best.rows[0].date
                : new Date(best.rows[0].date).toISOString().slice(0, 10),
            visitors: Number(best.rows[0].visitors),
          }
        : null,
      trendPct,
    });
  })
);

/** GET /api/timeseries — 30 days, chronological. */
app.get(
  '/api/timeseries',
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const { rows } = await db.query(
      `SELECT date, visitors, revenue
         FROM daily_metrics
        ORDER BY date ASC`
    );
    res.json(
      rows.map((r) => ({
        date: typeof r.date === 'string' ? r.date : new Date(r.date).toISOString().slice(0, 10),
        visitors: Number(r.visitors),
        revenue: Number(r.revenue),
      }))
    );
  })
);

/** GET /api/categories — 6 categories, descending by value. */
app.get(
  '/api/categories',
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const { rows } = await db.query(
      `SELECT name, value FROM categories ORDER BY value DESC`
    );
    res.json(rows.map((r) => ({ name: r.name, value: Number(r.value) })));
  })
);

/** GET /api/recent — 20 recent items, newest first. */
app.get(
  '/api/recent',
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const { rows } = await db.query(
      `SELECT name, category, value, created_at
         FROM recent_items
        ORDER BY created_at DESC`
    );
    res.json(
      rows.map((r) => ({
        name: r.name,
        category: r.category,
        value: Number(r.value),
        createdAt:
          typeof r.created_at === 'string'
            ? r.created_at
            : new Date(r.created_at).toISOString(),
      }))
    );
  })
);

/** GET /api/settings — { theme }. */
app.get(
  '/api/settings',
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const { rows } = await db.query(
      `SELECT value FROM settings WHERE key = 'theme'`
    );
    res.json({ theme: rows[0] ? rows[0].value : 'light' });
  })
);

/** PUT /api/settings — persist { theme: 'light' | 'dark' }. */
app.put(
  '/api/settings',
  asyncHandler(async (req, res) => {
    const theme = req.body && req.body.theme;
    if (theme !== 'light' && theme !== 'dark') {
      res.status(400).json({ error: "theme must be 'light' or 'dark'" });
      return;
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

// Serve the built frontend if it exists (production convenience).
const clientDist = path.resolve(__dirname, '..', '..', 'client', 'dist');
app.use(express.static(clientDist));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

getDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Metrics dashboard API listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
