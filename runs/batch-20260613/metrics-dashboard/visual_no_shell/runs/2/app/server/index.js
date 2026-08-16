import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'metrics.db');

const app = express();
app.use(cors());
app.use(express.json());

// ── Database initialisation ──────────────────────────────────────────────────

let db;

async function initDb() {
  db = new PGlite(`file://${DB_PATH}`);
  await db.waitReady;
  await createSchema();
  await seedIfEmpty();
}

async function createSchema() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id         SERIAL PRIMARY KEY,
      date       DATE        NOT NULL UNIQUE,
      visitors   INTEGER     NOT NULL,
      revenue    NUMERIC(12,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id         SERIAL PRIMARY KEY,
      name       TEXT        NOT NULL UNIQUE,
      value      BIGINT      NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_items (
      id         SERIAL PRIMARY KEY,
      name       TEXT        NOT NULL,
      category   TEXT        NOT NULL,
      value      NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL
    );
  `);
}

// ── Deterministic seed ───────────────────────────────────────────────────────
// Simple LCG so we get the same numbers every time without an external library.
function makeLcg(seed) {
  let s = seed >>> 0;
  return function () {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

async function seedIfEmpty() {
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM daily_metrics');
  if (rows[0].n > 0) return; // already seeded

  const rng = makeLcg(42);

  // ── daily_metrics: 30 days ending yesterday ──────────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dailyRows = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const visitors = Math.floor(rng() * 4500) + 500;          // 500–5000
    const revenue  = (rng() * 9000 + 1000).toFixed(2);        // 1000–10000
    dailyRows.push(`('${dateStr}', ${visitors}, ${revenue})`);
  }
  await db.exec(`INSERT INTO daily_metrics (date, visitors, revenue) VALUES ${dailyRows.join(',')};`);

  // ── categories ────────────────────────────────────────────────────────────
  const categories = [
    ['Enterprise Infrastructure & Compliance', 1_250_000],
    ['Cloud Services',                           487_320],
    ['Professional Services',                    312_800],
    ['Support & Maintenance',                    198_450],
    ['Training & Certification',                  87_600],
    ['Marketplace Add-ons',                       43_210],
  ];
  const catRows = categories.map(([n, v]) => `('${n}', ${v})`).join(',');
  await db.exec(`INSERT INTO categories (name, value) VALUES ${catRows};`);

  // ── recent_items ──────────────────────────────────────────────────────────
  const catNames = categories.map(c => c[0]);
  const itemRows = [];
  const baseTime = new Date(today);
  for (let i = 0; i < 20; i++) {
    const name     = `Item ${String.fromCharCode(65 + i)} — ${['Alpha','Beta','Gamma','Delta','Epsilon'][i % 5]}`;
    const category = catNames[i % catNames.length].replace(/'/g, "''");
    const value    = (rng() * 5000 + 100).toFixed(2);
    const ts       = new Date(baseTime.getTime() - i * 3_600_000).toISOString();
    itemRows.push(`('${name}', '${category}', ${value}, '${ts}')`);
  }
  await db.exec(`INSERT INTO recent_items (name, category, value, created_at) VALUES ${itemRows.join(',')};`);

  // ── settings ──────────────────────────────────────────────────────────────
  await db.exec(`INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT DO NOTHING;`);

  console.log('Database seeded.');
}

// ── API routes ───────────────────────────────────────────────────────────────

// GET /api/summary
app.get('/api/summary', async (_req, res) => {
  try {
    const { rows: totals } = await db.query(`
      SELECT
        SUM(visitors)::bigint          AS total_visitors,
        SUM(revenue)::numeric          AS total_revenue,
        MAX(visitors)::int             AS best_day_visitors,
        (SELECT date FROM daily_metrics ORDER BY visitors DESC LIMIT 1) AS best_day_date
      FROM daily_metrics
    `);

    // 7-day trend: compare last 7 days vs previous 7 days
    const { rows: trend } = await db.query(`
      WITH ordered AS (
        SELECT visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM daily_metrics
      ),
      last7   AS (SELECT SUM(visitors) AS s FROM ordered WHERE rn <= 7),
      prev7   AS (SELECT SUM(visitors) AS s FROM ordered WHERE rn > 7 AND rn <= 14)
      SELECT
        CASE WHEN prev7.s = 0 THEN 0
             ELSE ROUND(((last7.s - prev7.s)::numeric / prev7.s) * 100, 1)
        END AS trend_pct
      FROM last7, prev7
    `);

    const t = totals[0];
    res.json({
      total_visitors:   Number(t.total_visitors),
      total_revenue:    Number(t.total_revenue),
      best_day_visitors: Number(t.best_day_visitors),
      best_day_date:    t.best_day_date,
      trend_pct:        Number(trend[0].trend_pct),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/timeseries
app.get('/api/timeseries', async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT date, visitors::int, revenue::numeric FROM daily_metrics ORDER BY date ASC`
    );
    res.json(rows.map(r => ({
      date:     r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
      visitors: Number(r.visitors),
      revenue:  Number(r.revenue),
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/categories
app.get('/api/categories', async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT name, value::bigint FROM categories ORDER BY value DESC`
    );
    res.json(rows.map(r => ({ name: r.name, value: Number(r.value) })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/recent
app.get('/api/recent', async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT name, category, value::numeric, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20`
    );
    res.json(rows.map(r => ({
      name:       r.name,
      category:   r.category,
      value:      Number(r.value),
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings
app.get('/api/settings', async (_req, res) => {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'theme'`);
    res.json({ theme: rows[0]?.value ?? 'light' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings
app.put('/api/settings', async (req, res) => {
  try {
    const { theme } = req.body;
    if (theme !== 'light' && theme !== 'dark') {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    await db.query(`UPDATE settings SET value = $1 WHERE key = 'theme'`, [theme]);
    res.json({ theme });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Static frontend (for production / direct access) ─────────────────────────
// Serve the client files directly from the source for dev convenience
const clientDir = path.join(__dirname, '..', 'client');
const distDir   = path.join(__dirname, '..', 'dist');

// Serve static assets (JS, CSS) from client directory
app.use('/style.css', express.static(path.join(clientDir, 'style.css')));
app.use('/main.js',   express.static(path.join(clientDir, 'main.js')));

// Serve HTML pages
app.get('/', (_req, res) => {
  const distIndex = path.join(distDir, 'index.html');
  const srcIndex  = path.join(clientDir, 'index.html');
  res.sendFile(fs.existsSync(distIndex) ? distIndex : srcIndex);
});

app.get('/dark', (_req, res) => {
  res.sendFile(path.join(clientDir, 'dark.html'));
});

app.get('/narrow', (_req, res) => {
  res.sendFile(path.join(clientDir, 'narrow.html'));
});

app.get('/tablet', (_req, res) => {
  res.sendFile(path.join(clientDir, 'tablet.html'));
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialise database:', err);
    process.exit(1);
  });
