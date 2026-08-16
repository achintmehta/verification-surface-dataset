import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'db');

const app = express();
app.use(cors());
app.use(express.json());

// ── Database bootstrap ────────────────────────────────────────────────────────

let db;

async function initDb() {
  db = new PGlite(DB_PATH);
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

// Deterministic pseudo-random number generator (mulberry32)
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function seedIfEmpty() {
  const { rows } = await db.query('SELECT COUNT(*) AS cnt FROM daily_metrics');
  if (parseInt(rows[0].cnt, 10) > 0) return;

  const rand = mulberry32(0xdeadbeef);

  // ── daily_metrics: 30 days ending yesterday ──────────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dailyRows = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const visitors = Math.floor(rand() * 4500) + 500;   // 500–5000
    const revenue  = (rand() * 9000 + 1000).toFixed(2); // 1000–10000
    dailyRows.push(`('${dateStr}', ${visitors}, ${revenue})`);
  }
  await db.exec(
    `INSERT INTO daily_metrics (date, visitors, revenue) VALUES ${dailyRows.join(',')}`
  );

  // ── categories: 6 rows, one long label, one value ≥ 1 000 000 ────────────
  const categories = [
    ['Enterprise Infrastructure & Compliance', 1_250_000],
    ['Cloud Services',                          Math.floor(rand() * 400000) + 200000],
    ['Professional Services',                   Math.floor(rand() * 300000) + 100000],
    ['Support & Maintenance',                   Math.floor(rand() * 200000) + 50000],
    ['Training & Certification',                Math.floor(rand() * 150000) + 30000],
    ['Consulting',                              Math.floor(rand() * 100000) + 20000],
  ];
  const catRows = categories.map(([n, v]) => `('${n}', ${v})`).join(',');
  await db.exec(`INSERT INTO categories (name, value) VALUES ${catRows}`);

  // ── recent_items: 20 rows ─────────────────────────────────────────────────
  const catNames = categories.map(([n]) => n);
  const adjectives = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa'];
  const nouns      = ['Project', 'Initiative', 'Campaign', 'Contract', 'Engagement', 'Deployment', 'Migration', 'Audit', 'Review', 'Sprint'];

  const itemRows = [];
  for (let i = 0; i < 20; i++) {
    const name     = `${adjectives[i % adjectives.length]} ${nouns[i % nouns.length]}`;
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value    = (rand() * 50000 + 500).toFixed(2);
    const daysAgo  = Math.floor(rand() * 30);
    const ts       = new Date(today);
    ts.setDate(ts.getDate() - daysAgo);
    itemRows.push(`('${name}', '${category}', ${value}, '${ts.toISOString()}')`);
  }
  await db.exec(
    `INSERT INTO recent_items (name, category, value, created_at) VALUES ${itemRows.join(',')}`
  );

  // ── settings: default theme ───────────────────────────────────────────────
  await db.exec(`INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT DO NOTHING`);

  console.log('[db] Seed complete.');
}

// ── API routes ────────────────────────────────────────────────────────────────

// GET /api/summary
app.get('/api/summary', async (_req, res) => {
  try {
    const totals = await db.query(`
      SELECT
        SUM(visitors)::BIGINT   AS total_visitors,
        SUM(revenue)::NUMERIC   AS total_revenue,
        MAX(visitors)           AS best_day_visitors,
        (SELECT date FROM daily_metrics ORDER BY visitors DESC LIMIT 1) AS best_day_date
      FROM daily_metrics
    `);

    // 7-day trend: compare last 7 days vs previous 7 days
    const trend = await db.query(`
      WITH ordered AS (
        SELECT visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM daily_metrics
      ),
      last7   AS (SELECT SUM(visitors) AS s FROM ordered WHERE rn <= 7),
      prev7   AS (SELECT SUM(visitors) AS s FROM ordered WHERE rn > 7 AND rn <= 14)
      SELECT
        CASE WHEN prev7.s = 0 THEN 0
             ELSE ROUND(((last7.s - prev7.s)::NUMERIC / prev7.s) * 100, 1)
        END AS trend_pct
      FROM last7, prev7
    `);

    const row = totals.rows[0];
    res.json({
      total_visitors:   parseInt(row.total_visitors, 10),
      total_revenue:    parseFloat(row.total_revenue),
      best_day_visitors: parseInt(row.best_day_visitors, 10),
      best_day_date:    row.best_day_date,
      trend_pct:        parseFloat(trend.rows[0].trend_pct),
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
      `SELECT date, visitors, revenue::FLOAT AS revenue
       FROM daily_metrics ORDER BY date ASC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/categories
app.get('/api/categories', async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT name, value FROM categories ORDER BY value DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/recent
app.get('/api/recent', async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT name, category, value::FLOAT AS value, created_at
       FROM recent_items ORDER BY created_at DESC LIMIT 20`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings
app.get('/api/settings', async (_req, res) => {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'theme'`);
    res.json({ theme: rows[0]?.value ?? 'light' });
  } catch (err) {
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
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('theme', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [theme]
    );
    res.json({ theme });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`[server] Listening on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('[db] Failed to initialise:', err);
    process.exit(1);
  });
