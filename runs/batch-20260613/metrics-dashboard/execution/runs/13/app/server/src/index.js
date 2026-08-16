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

// ---------------------------------------------------------------------------
// Summary: total visitors, total revenue, best day, 7-day trend %
// ---------------------------------------------------------------------------
app.get('/api/summary', async (req, res, next) => {
  try {
    const db = await getDb();
    const totals = await db.query(`
      SELECT
        COALESCE(SUM(visitors), 0)::bigint AS total_visitors,
        COALESCE(SUM(revenue), 0)::numeric AS total_revenue
      FROM daily_metrics
    `);

    const best = await db.query(`
      SELECT day, visitors
      FROM daily_metrics
      ORDER BY visitors DESC, day DESC
      LIMIT 1
    `);

    // 7-day trend: sum of last 7 days vs the 7 days before that, by visitors.
    const series = await db.query(`
      SELECT visitors FROM daily_metrics ORDER BY day ASC
    `);
    const v = series.rows.map((r) => Number(r.visitors));
    const n = v.length;
    const last7 = v.slice(Math.max(0, n - 7)).reduce((a, b) => a + b, 0);
    const prev7 = v.slice(Math.max(0, n - 14), Math.max(0, n - 7)).reduce((a, b) => a + b, 0);
    const trendPct = prev7 === 0 ? 0 : ((last7 - prev7) / prev7) * 100;

    const t = totals.rows[0];
    res.json({
      totalVisitors: Number(t.total_visitors),
      totalRevenue: Number(t.total_revenue),
      bestDay: best.rows.length
        ? { day: best.rows[0].day, visitors: Number(best.rows[0].visitors) }
        : null,
      trendPct: Math.round(trendPct * 10) / 10,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Time series (30 days)
// ---------------------------------------------------------------------------
app.get('/api/timeseries', async (req, res, next) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(`
      SELECT day, visitors, revenue
      FROM daily_metrics
      ORDER BY day ASC
    `);
    res.json(
      rows.map((r) => ({
        day: typeof r.day === 'string' ? r.day : new Date(r.day).toISOString().slice(0, 10),
        visitors: Number(r.visitors),
        revenue: Number(r.revenue),
      }))
    );
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------
app.get('/api/categories', async (req, res, next) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(`
      SELECT name, value FROM categories ORDER BY value DESC
    `);
    res.json(rows.map((r) => ({ name: r.name, value: Number(r.value) })));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Recent items
// ---------------------------------------------------------------------------
app.get('/api/recent', async (req, res, next) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(`
      SELECT name, category, value, created_at
      FROM recent_items
      ORDER BY created_at DESC
      LIMIT 20
    `);
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

// ---------------------------------------------------------------------------
// Settings (theme)
// ---------------------------------------------------------------------------
app.get('/api/settings', async (req, res, next) => {
  try {
    const db = await getDb();
    const { rows } = await db.query('SELECT theme FROM settings WHERE id = 1');
    res.json({ theme: rows.length ? rows[0].theme : 'light' });
  } catch (err) {
    next(err);
  }
});

app.put('/api/settings', async (req, res, next) => {
  try {
    const theme = req.body && req.body.theme;
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
  } catch (err) {
    next(err);
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Serve the built client (production) if it exists.
const clientDist = path.resolve(__dirname, '..', '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) next();
  });
});

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_server_error' });
});

getDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`metrics-dashboard server listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
