import express from 'express';
import cors from 'cors';
import { initDb, getDb } from './db.js';

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

// --- Helpers ---------------------------------------------------------------

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// --- API routes ------------------------------------------------------------

// Summary: total visitors, total revenue, best day, 7-day trend %.
app.get(
  '/api/summary',
  asyncHandler(async (req, res) => {
    const db = getDb();

    const totals = await db.query(
      `SELECT COALESCE(SUM(visitors),0)::bigint AS total_visitors,
              COALESCE(SUM(revenue),0)::numeric AS total_revenue
       FROM daily_metrics`
    );

    const best = await db.query(
      `SELECT to_char(date,'YYYY-MM-DD') AS date, visitors
       FROM daily_metrics
       ORDER BY visitors DESC, date DESC
       LIMIT 1`
    );

    // 7-day trend: sum of last 7 days vs the preceding 7 days (visitors).
    const ordered = await db.query(
      `SELECT visitors FROM daily_metrics ORDER BY date ASC`
    );
    const visitorsArr = ordered.rows.map((r) => Number(r.visitors));
    const n = visitorsArr.length;
    const last7 = visitorsArr.slice(Math.max(0, n - 7)).reduce((a, b) => a + b, 0);
    const prev7 = visitorsArr
      .slice(Math.max(0, n - 14), Math.max(0, n - 7))
      .reduce((a, b) => a + b, 0);
    let trendPct = 0;
    if (prev7 > 0) trendPct = ((last7 - prev7) / prev7) * 100;
    trendPct = Math.round(trendPct * 10) / 10;

    res.json({
      totalVisitors: Number(totals.rows[0].total_visitors),
      totalRevenue: Number(totals.rows[0].total_revenue),
      bestDay: best.rows[0]
        ? { date: best.rows[0].date, visitors: Number(best.rows[0].visitors) }
        : null,
      trendPct,
    });
  })
);

app.get(
  '/api/timeseries',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const r = await db.query(
      `SELECT to_char(date,'YYYY-MM-DD') AS date, visitors, revenue
       FROM daily_metrics ORDER BY date ASC`
    );
    res.json(
      r.rows.map((row) => ({
        date: row.date,
        visitors: Number(row.visitors),
        revenue: Number(row.revenue),
      }))
    );
  })
);

app.get(
  '/api/categories',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const r = await db.query(
      `SELECT name, value FROM categories ORDER BY value DESC`
    );
    res.json(r.rows.map((row) => ({ name: row.name, value: Number(row.value) })));
  })
);

app.get(
  '/api/recent',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const r = await db.query(
      `SELECT name, category, value, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
       FROM recent_items ORDER BY created_at DESC`
    );
    res.json(
      r.rows.map((row) => ({
        name: row.name,
        category: row.category,
        value: Number(row.value),
        createdAt: row.created_at,
      }))
    );
  })
);

app.get(
  '/api/settings',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const r = await db.query(`SELECT value FROM settings WHERE key='theme'`);
    const theme = r.rows[0] ? r.rows[0].value : 'light';
    res.json({ theme });
  })
);

app.put(
  '/api/settings',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const theme = req.body && req.body.theme;
    if (theme !== 'light' && theme !== 'dark') {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('theme', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [theme]
    );
    res.json({ theme });
  })
);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Error handler.
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

initDb()
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
