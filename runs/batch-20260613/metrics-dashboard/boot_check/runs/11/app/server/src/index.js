import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { getDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

// --- API ---------------------------------------------------------------

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/summary', async (_req, res, next) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, visitors, revenue::float8 AS revenue
       FROM daily_metrics ORDER BY day ASC`
    );
    const totalVisitors = rows.reduce((a, r) => a + r.visitors, 0);
    const totalRevenue = rows.reduce((a, r) => a + Number(r.revenue), 0);

    // Best day = day with max revenue.
    let best = rows[0];
    for (const r of rows) if (Number(r.revenue) > Number(best.revenue)) best = r;

    // 7-day trend %: sum of last 7 days vs the prior 7 days (visitors).
    const last7 = rows.slice(-7).reduce((a, r) => a + r.visitors, 0);
    const prev7 = rows.slice(-14, -7).reduce((a, r) => a + r.visitors, 0);
    const trendPct = prev7 === 0 ? 0 : ((last7 - prev7) / prev7) * 100;

    res.json({
      totalVisitors,
      totalRevenue: +totalRevenue.toFixed(2),
      bestDay: { day: best.day, revenue: +Number(best.revenue).toFixed(2) },
      trendPct: +trendPct.toFixed(1),
    });
  } catch (e) {
    next(e);
  }
});

app.get('/api/timeseries', async (_req, res, next) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, visitors, revenue::float8 AS revenue
       FROM daily_metrics ORDER BY day ASC`
    );
    res.json(rows.map((r) => ({ day: r.day, visitors: r.visitors, revenue: Number(r.revenue) })));
  } catch (e) {
    next(e);
  }
});

app.get('/api/categories', async (_req, res, next) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(
      `SELECT id, name, value::float8 AS value FROM categories ORDER BY value DESC`
    );
    res.json(rows.map((r) => ({ id: r.id, name: r.name, value: Number(r.value) })));
  } catch (e) {
    next(e);
  }
});

app.get('/api/recent', async (_req, res, next) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(
      `SELECT id, name, category, value::float8 AS value,
              to_char(created_at, 'YYYY-MM-DD HH24:MI') AS created_at
       FROM recent_items ORDER BY created_at DESC`
    );
    res.json(rows.map((r) => ({ ...r, value: Number(r.value) })));
  } catch (e) {
    next(e);
  }
});

app.get('/api/settings', async (_req, res, next) => {
  try {
    const db = await getDb();
    const { rows } = await db.query('SELECT theme FROM settings WHERE id = 1');
    res.json({ theme: rows[0]?.theme ?? 'light' });
  } catch (e) {
    next(e);
  }
});

app.put('/api/settings', async (req, res, next) => {
  try {
    const theme = req.body?.theme;
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
  } catch (e) {
    next(e);
  }
});

// --- Static client (production build) ----------------------------------

const clientDist = path.resolve(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// --- Error handler -----------------------------------------------------

app.use((err, _req, res, _next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'internal_server_error' });
});

getDb()
  .then(() => {
    app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`metrics-dashboard server listening on http://localhost:${PORT}`);
    });
  })
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error('Failed to initialize database:', e);
    process.exit(1);
  });
