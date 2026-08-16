import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'db');

// Ensure the data directory exists before PGLite tries to use it
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());

// ── Database ──────────────────────────────────────────────────────────────────

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
      id        SERIAL PRIMARY KEY,
      date      DATE NOT NULL UNIQUE,
      visitors  INTEGER NOT NULL,
      revenue   NUMERIC(12,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id    SERIAL PRIMARY KEY,
      name  TEXT NOT NULL UNIQUE,
      value BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_items (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      category   TEXT NOT NULL,
      value      NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

// Deterministic pseudo-random number generator (mulberry32)
function makePrng(seed) {
  let s = seed >>> 0;
  return function () {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function seedIfEmpty() {
  const { rows } = await db.query('SELECT COUNT(*) AS cnt FROM daily_metrics');
  if (parseInt(rows[0].cnt, 10) > 0) return;

  const rand = makePrng(0xdeadbeef);

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
    `INSERT INTO daily_metrics (date, visitors, revenue) VALUES ${dailyRows.join(',')} ON CONFLICT DO NOTHING`
  );

  // ── categories: 6 rows ───────────────────────────────────────────────────
  const categories = [
    ['Enterprise Infrastructure & Compliance', 1_250_000],
    ['Cloud Services',                          487_320],
    ['Professional Services',                   312_800],
    ['Support & Maintenance',                   198_450],
    ['Training & Certification',                 87_600],
    ['Consulting',                               54_200],
  ];
  const catRows = categories.map(([name, value]) => `('${name}', ${value})`).join(',');
  await db.exec(
    `INSERT INTO categories (name, value) VALUES ${catRows} ON CONFLICT DO NOTHING`
  );

  // ── recent_items: 20 rows ────────────────────────────────────────────────
  const catNames = categories.map(([n]) => n);
  const itemRows = [];
  for (let i = 0; i < 20; i++) {
    const cat   = catNames[Math.floor(rand() * catNames.length)];
    const value = (rand() * 50000 + 500).toFixed(2);
    const name  = `Item ${String.fromCharCode(65 + i)} — ${cat.split(' ')[0]}`;
    // created_at spread over last 30 days
    const daysAgo = Math.floor(rand() * 30);
    const ts = new Date(today);
    ts.setDate(ts.getDate() - daysAgo);
    const tsStr = ts.toISOString();
    itemRows.push(`('${name.replace(/'/g, "''")}', '${cat.replace(/'/g, "''")}', ${value}, '${tsStr}')`);
  }
  await db.exec(
    `INSERT INTO recent_items (name, category, value, created_at) VALUES ${itemRows.join(',')}`
  );

  // ── settings: default theme ──────────────────────────────────────────────
  await db.exec(
    `INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT DO NOTHING`
  );

  console.log('Database seeded.');
}

// ── API Routes ────────────────────────────────────────────────────────────────

// GET /api/summary
app.get('/api/summary', async (_req, res) => {
  try {
    const totals = await db.query(`
      SELECT
        SUM(visitors)::BIGINT  AS total_visitors,
        SUM(revenue)::NUMERIC  AS total_revenue
      FROM daily_metrics
    `);

    const best = await db.query(`
      SELECT date, visitors, revenue
      FROM daily_metrics
      ORDER BY revenue DESC
      LIMIT 1
    `);

    // 7-day trend: compare last 7 days vs prior 7 days (by revenue)
    const trend = await db.query(`
      WITH ordered AS (
        SELECT revenue, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM daily_metrics
      ),
      last7  AS (SELECT SUM(revenue) AS s FROM ordered WHERE rn <= 7),
      prior7 AS (SELECT SUM(revenue) AS s FROM ordered WHERE rn BETWEEN 8 AND 14)
      SELECT
        CASE WHEN prior7.s = 0 THEN 0
             ELSE ROUND(((last7.s - prior7.s) / prior7.s) * 100, 1)
        END AS trend_pct
      FROM last7, prior7
    `);

    res.json({
      total_visitors: parseInt(totals.rows[0].total_visitors, 10),
      total_revenue:  parseFloat(totals.rows[0].total_revenue),
      best_day: {
        date:     best.rows[0].date,
        visitors: best.rows[0].visitors,
        revenue:  parseFloat(best.rows[0].revenue),
      },
      trend_pct: parseFloat(trend.rows[0].trend_pct),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/timeseries
app.get('/api/timeseries', async (_req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT date, visitors, revenue::FLOAT AS revenue
      FROM daily_metrics
      ORDER BY date ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/categories
app.get('/api/categories', async (_req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT name, value
      FROM categories
      ORDER BY value DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/recent
app.get('/api/recent', async (_req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT name, category, value::FLOAT AS value, created_at
      FROM recent_items
      ORDER BY created_at DESC
      LIMIT 20
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings
app.get('/api/settings', async (_req, res) => {
  try {
    const { rows } = await db.query(`SELECT key, value FROM settings`);
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json(settings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings
app.put('/api/settings', async (req, res) => {
  try {
    const { theme } = req.body;
    if (!['light', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('theme', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [theme]
    );
    res.json({ theme });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server listening on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
