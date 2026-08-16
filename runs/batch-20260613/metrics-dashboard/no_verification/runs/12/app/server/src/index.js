import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Helper: wrap async route handlers so errors return JSON 500s.
const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });
};

app.get(
  '/api/health',
  wrap(async (_req, res) => {
    res.json({ ok: true });
  })
);

// ---- Summary: four headline numbers ----
app.get(
  '/api/summary',
  wrap(async (_req, res) => {
    const db = await getDb();
    const rows = (
      await db.query(
        'SELECT date::text AS date, visitors, revenue::float8 AS revenue FROM daily_metrics ORDER BY date ASC'
      )
    ).rows;

    const totalVisitors = rows.reduce((s, r) => s + r.visitors, 0);
    const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);

    let best = rows[0] || null;
    for (const r of rows) {
      if (!best || r.visitors > best.visitors) best = r;
    }

    // 7-day trend: sum of last 7 days visitors vs the previous 7 days.
    const last7 = rows.slice(-7).reduce((s, r) => s + r.visitors, 0);
    const prev7 = rows.slice(-14, -7).reduce((s, r) => s + r.visitors, 0);
    let trendPct = 0;
    if (prev7 > 0) {
      trendPct = ((last7 - prev7) / prev7) * 100;
    }

    res.json({
      totalVisitors,
      totalRevenue: +totalRevenue.toFixed(2),
      bestDay: best ? { date: best.date, visitors: best.visitors } : null,
      trendPct: +trendPct.toFixed(1),
    });
  })
);

// ---- Time series: 30 days ----
app.get(
  '/api/timeseries',
  wrap(async (_req, res) => {
    const db = await getDb();
    const rows = (
      await db.query(
        'SELECT date::text AS date, visitors, revenue::float8 AS revenue FROM daily_metrics ORDER BY date ASC'
      )
    ).rows;
    res.json(rows);
  })
);

// ---- Categories ----
app.get(
  '/api/categories',
  wrap(async (_req, res) => {
    const db = await getDb();
    const rows = (
      await db.query(
        'SELECT name, value::float8 AS value FROM categories ORDER BY value DESC'
      )
    ).rows;
    res.json(rows);
  })
);

// ---- Recent items ----
app.get(
  '/api/recent',
  wrap(async (_req, res) => {
    const db = await getDb();
    const rows = (
      await db.query(
        `SELECT name, category, value::float8 AS value, created_at
         FROM recent_items
         ORDER BY created_at DESC`
      )
    ).rows;
    res.json(rows);
  })
);

// ---- Settings (theme) ----
app.get(
  '/api/settings',
  wrap(async (_req, res) => {
    const db = await getDb();
    const rows = (await db.query('SELECT theme FROM settings WHERE id = 1')).rows;
    const theme = rows[0]?.theme || 'light';
    res.json({ theme });
  })
);

app.put(
  '/api/settings',
  wrap(async (req, res) => {
    const { theme } = req.body || {};
    if (theme !== 'light' && theme !== 'dark') {
      return res.status(400).json({ error: "theme must be 'light' or 'dark'" });
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

async function start() {
  // Touch the DB up front so the schema/seed runs at boot.
  await getDb();
  app.listen(PORT, () => {
    console.log(`Metrics dashboard API listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
