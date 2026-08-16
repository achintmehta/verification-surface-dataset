import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;
const db = new PGlite(path.join(process.cwd(), 'pglite-data'));

const app = express();
app.use(cors());
app.use(express.json());

function sqlDate(offsetFromStart) {
  const d = new Date(Date.UTC(2024, 5, 1 + offsetFromStart));
  return d.toISOString().slice(0, 10);
}

function dailyRows() {
  const rows = [];
  for (let i = 0; i < 30; i += 1) {
    const weekdayLift = [0, 1800, 2700, 3200, 2900, 1500, -900][i % 7];
    const visitors = 31500 + i * 410 + weekdayLift + ((i * 977) % 1900);
    const revenue = 65500 + i * 1475 + Math.round(visitors * 0.42) + ((i * 611) % 5200);
    rows.push({ date: sqlDate(i), visitors, revenue });
  }
  return rows;
}

const categoryRows = [
  { label: 'Enterprise Infrastructure & Compliance', value: 1250000 },
  { label: 'Product Analytics', value: 824300 },
  { label: 'Customer Success', value: 597840 },
  { label: 'Marketing Operations', value: 478920 },
  { label: 'Developer Platform', value: 356400 },
  { label: 'Finance Automation', value: 214750 }
];

const itemNames = [
  'Northwind renewal', 'Pulse onboarding', 'Atlas expansion', 'Beacon audit', 'Cobalt migration',
  'Delta pilot', 'Evergreen rollout', 'Fable enablement', 'Granite import', 'Helio review',
  'Ion integration', 'Juniper kickoff', 'Keystone cleanup', 'Lumen forecast', 'Monarch sync',
  'Nimbus upgrade', 'Orbit handoff', 'Prairie cohort', 'Quartz closeout', 'Riverbank analysis'
];

async function initDb() {
  await db.query(`CREATE TABLE IF NOT EXISTS daily_metrics (
    id SERIAL PRIMARY KEY,
    day DATE NOT NULL UNIQUE,
    visitors INTEGER NOT NULL,
    revenue INTEGER NOT NULL
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    label TEXT NOT NULL UNIQUE,
    value INTEGER NOT NULL
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS recent_items (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    value INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  const existing = await db.query('SELECT COUNT(*)::int AS count FROM daily_metrics');
  if (Number(existing.rows[0]?.count || 0) === 0) {
    await db.query('BEGIN');
    try {
      for (const row of dailyRows()) {
        await db.query('INSERT INTO daily_metrics (day, visitors, revenue) VALUES ($1, $2, $3)', [row.date, row.visitors, row.revenue]);
      }
      for (const row of categoryRows) {
        await db.query('INSERT INTO categories (label, value) VALUES ($1, $2)', [row.label, row.value]);
      }
      for (let i = 0; i < 20; i += 1) {
        const category = categoryRows[i % categoryRows.length].label;
        const value = 8400 + ((i * 7319) % 87500) + i * 1700;
        const createdAt = new Date(Date.UTC(2024, 5, 30, 15, 0, 0) - i * 31 * 60 * 60 * 1000).toISOString();
        await db.query(
          'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, CAST($4 AS timestamptz))',
          [itemNames[i], category, value, createdAt]
        );
      }
      await db.query("INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING");
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  } else {
    await db.query("INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING");
  }
}

function sendError(res, error) {
  console.error(error);
  res.status(500).json({ error: 'The metrics database could not be read.' });
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/summary', async (_req, res) => {
  try {
    const rows = (await db.query("SELECT to_char(day, 'YYYY-MM-DD') AS day, visitors, revenue FROM daily_metrics ORDER BY day ASC")).rows;
    const totalVisitors = rows.reduce((sum, row) => sum + Number(row.visitors), 0);
    const totalRevenue = rows.reduce((sum, row) => sum + Number(row.revenue), 0);
    if (rows.length === 0) return res.status(503).json({ error: 'Metrics have not been seeded yet.' });
    const bestRow = rows.reduce((best, row) => (Number(row.visitors) > Number(best.visitors) ? row : best), rows[0]);
    const lastSeven = rows.slice(-7).reduce((sum, row) => sum + Number(row.visitors), 0);
    const previousSeven = rows.slice(-14, -7).reduce((sum, row) => sum + Number(row.visitors), 0);
    const trend = previousSeven === 0 ? 0 : ((lastSeven - previousSeven) / previousSeven) * 100;
    res.json({
      totalVisitors,
      totalRevenue,
      bestDay: { day: bestRow.day, visitors: Number(bestRow.visitors), revenue: Number(bestRow.revenue) },
      sevenDayTrend: Number(trend.toFixed(1))
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/timeseries', async (_req, res) => {
  try {
    const result = await db.query("SELECT to_char(day, 'YYYY-MM-DD') AS date, visitors, revenue FROM daily_metrics ORDER BY day ASC");
    res.json(result.rows.map((r) => ({ date: r.date, visitors: Number(r.visitors), revenue: Number(r.revenue) })));
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/categories', async (_req, res) => {
  try {
    const result = await db.query('SELECT label, value FROM categories ORDER BY value DESC');
    res.json(result.rows.map((r) => ({ label: r.label, value: Number(r.value) })));
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/recent', async (_req, res) => {
  try {
    const result = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20');
    res.json(result.rows.map((r) => ({ name: r.name, category: r.category, value: Number(r.value), created_at: r.created_at })));
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/settings', async (_req, res) => {
  try {
    const result = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    const theme = result.rows[0]?.value === 'dark' ? 'dark' : 'light';
    res.json({ theme });
  } catch (error) {
    sendError(res, error);
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const theme = req.body?.theme;
    if (theme !== 'light' && theme !== 'dark') {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    await db.query("INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [theme]);
    res.json({ theme });
  } catch (error) {
    sendError(res, error);
  }
});

const distPath = path.join(process.cwd(), 'dist');
app.use(express.static(distPath));
app.get('*', (_req, res) => {
  const indexPath = path.join(distPath, 'index.html');
  res.sendFile(indexPath, (error) => {
    if (error) res.status(404).json({ error: 'Frontend build not found. Run npm run frontend for Vite dev or npm run build first.' });
  });
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Metrics dashboard API listening on http://localhost:${PORT}`));
  })
  .catch((error) => {
    console.error('Failed to initialize PGLite database', error);
    process.exit(1);
  });
