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

// --- Helpers -----------------------------------------------------------------

function asyncRoute(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    });
  };
}

// --- API routes --------------------------------------------------------------

// GET /api/summary -> four headline numbers
app.get(
  '/api/summary',
  asyncRoute(async (req, res) => {
    const db = await getDb();

    const totals = await db.query(
      `SELECT COALESCE(SUM(visitors),0)::bigint AS total_visitors,
              COALESCE(SUM(revenue),0)::numeric AS total_revenue
       FROM daily_metrics`
    );

    const best = await db.query(
      `SELECT day, visitors FROM daily_metrics
       ORDER BY visitors DESC, day ASC LIMIT 1`
    );

    // 7-day trend: sum of last 7 days vs the prior 7 days (by visitors).
    const ordered = await db.query(
      `SELECT visitors FROM daily_metrics ORDER BY day ASC`
    );
    const vals = ordered.rows.map((r) => Number(r.visitors));
    const last7 = vals.slice(-7).reduce((a, b) => a + b, 0);
    const prev7 = vals.slice(-14, -7).reduce((a, b) => a + b, 0);
    const trendPct = prev7 > 0 ? ((last7 - prev7) / prev7) * 100 : 0;

    res.json({
      totalVisitors: Number(totals.rows[0].total_visitors),
      totalRevenue: Number(totals.rows[0].total_revenue),
      bestDay: best.rows[0]
        ? { day: best.rows[0].day, visitors: Number(best.rows[0].visitors) }
        : null,
      trendPct: Math.round(trendPct * 10) / 10,
    });
  })
);

// GET /api/timeseries -> the 30-day series
app.get(
  '/api/timeseries',
  asyncRoute(async (req, res) => {
    const db = await getDb();
    const { rows } = await db.query(
      `SELECT day, visitors, revenue FROM daily_metrics ORDER BY day ASC`
    );
    res.json(
      rows.map((r) => ({
        day: typeof r.day === 'string' ? r.day : new Date(r.day).toISOString().slice(0, 10),
        visitors: Number(r.visitors),
        revenue: Number(r.revenue),
      }))
    );
  })
);

// GET /api/categories -> category breakdown
app.get(
  '/api/categories',
  asyncRoute(async (req, res) => {
    const db = await getDb();
    const { rows } = await db.query(
      `SELECT name, value FROM categories ORDER BY value DESC`
    );
    res.json(rows.map((r) => ({ name: r.name, value: Number(r.value) })));
  })
);

// GET /api/recent -> recent items table
app.get(
  '/api/recent',
  asyncRoute(async (req, res) => {
    const db = await getDb();
    const { rows } = await db.query(
      `SELECT name, category, value, created_at
       FROM recent_items ORDER BY created_at DESC LIMIT 20`
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

// GET /api/settings -> { theme }
app.get(
  '/api/settings',
  asyncRoute(async (req, res) => {
    const db = await getDb();
    const { rows } = await db.query(`SELECT theme FROM settings WHERE id = 1`);
    res.json({ theme: rows[0] ? rows[0].theme : 'light' });
  })
);

// PUT /api/settings -> persist { theme }
app.put(
  '/api/settings',
  asyncRoute(async (req, res) => {
    const theme = req.body && req.body.theme;
    if (theme !== 'light' && theme !== 'dark') {
      res.status(400).json({ error: "theme must be 'light' or 'dark'" });
      return;
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

// --- Static frontend (production build) -------------------------------------

const distDir = path.join(__dirname, '..', 'dist');
app.use(express.static(distDir));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distDir, 'index.html'), (err) => {
    if (err) next();
  });
});

// --- Boot --------------------------------------------------------------------

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
