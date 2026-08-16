import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, 'data', 'pglite');

// Ensure data directory exists
mkdirSync(DB_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());

// ─── Database Setup ───────────────────────────────────────────────────────────

let db;

async function initDB() {
  db = new PGlite(DB_DIR);
  await db.waitReady;

  // Create schema
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
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Check if already seeded
  const { rows } = await db.query('SELECT COUNT(*) AS cnt FROM daily_metrics');
  if (parseInt(rows[0].cnt, 10) === 0) {
    await seedDatabase();
  }
}

// ─── Deterministic Seed ───────────────────────────────────────────────────────

function seededRandom(seed) {
  // Simple LCG PRNG
  let s = seed;
  return function () {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

async function seedDatabase() {
  const rand = seededRandom(42);

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

  await db.exec(`
    INSERT INTO daily_metrics (date, visitors, revenue)
    VALUES ${dailyRows.join(',\n')}
    ON CONFLICT (date) DO NOTHING;
  `);

  // ── categories: 6 rows, one long name, one value ≥ 1,000,000 ─────────────
  const categories = [
    ['Enterprise Infrastructure & Compliance', 1_250_000],
    ['Cloud Services',                          Math.floor(rand() * 400000) + 200000],
    ['Professional Services',                   Math.floor(rand() * 300000) + 100000],
    ['Support & Maintenance',                   Math.floor(rand() * 200000) + 50000],
    ['Training & Certification',                Math.floor(rand() * 150000) + 30000],
    ['Consulting',                              Math.floor(rand() * 100000) + 20000],
  ];

  for (const [name, value] of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
      [name, value]
    );
  }

  // ── recent_items: 20 rows ─────────────────────────────────────────────────
  const itemNames = [
    'Acme Corp Renewal', 'Beta Systems Upgrade', 'Gamma Cloud Migration',
    'Delta Compliance Audit', 'Epsilon Training Bundle', 'Zeta Support Contract',
    'Eta Consulting Retainer', 'Theta Infrastructure Setup', 'Iota Certification Pack',
    'Kappa Maintenance Plan', 'Lambda Security Review', 'Mu Data Pipeline',
    'Nu Analytics Suite', 'Xi Monitoring Stack', 'Omicron Backup Solution',
    'Pi Disaster Recovery', 'Rho Network Overhaul', 'Sigma Identity Platform',
    'Tau Observability Kit', 'Upsilon DevOps Bundle',
  ];

  const catNames = categories.map(([n]) => n);
  const baseTime = new Date(today);
  baseTime.setDate(baseTime.getDate() - 20);

  for (let i = 0; i < 20; i++) {
    const name     = itemNames[i];
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value    = (rand() * 49000 + 1000).toFixed(2);
    const ts       = new Date(baseTime.getTime() + i * 86_400_000 * rand());
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, ts.toISOString()]
    );
  }

  // ── settings: default theme ───────────────────────────────────────────────
  await db.exec(`
    INSERT INTO settings (key, value) VALUES ('theme', 'light')
    ON CONFLICT (key) DO NOTHING;
  `);

  console.log('✅ Database seeded');
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// GET /api/summary
app.get('/api/summary', async (_req, res) => {
  try {
    const totals = await db.query(`
      SELECT
        SUM(visitors)::bigint   AS total_visitors,
        SUM(revenue)::numeric   AS total_revenue,
        MAX(visitors)           AS best_day_visitors,
        (SELECT date FROM daily_metrics ORDER BY visitors DESC LIMIT 1) AS best_day_date
      FROM daily_metrics
    `);

    // 7-day trend: compare last 7 days vs prior 7 days
    const trend = await db.query(`
      WITH ordered AS (
        SELECT visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM daily_metrics
      ),
      last7  AS (SELECT SUM(visitors) AS s FROM ordered WHERE rn <= 7),
      prior7 AS (SELECT SUM(visitors) AS s FROM ordered WHERE rn BETWEEN 8 AND 14)
      SELECT
        CASE WHEN prior7.s = 0 THEN 0
             ELSE ROUND(((last7.s - prior7.s)::numeric / prior7.s) * 100, 1)
        END AS trend_pct
      FROM last7, prior7
    `);

    const row = totals.rows[0];
    res.json({
      total_visitors:  parseInt(row.total_visitors, 10),
      total_revenue:   parseFloat(row.total_revenue),
      best_day_visitors: parseInt(row.best_day_visitors, 10),
      best_day_date:   row.best_day_date,
      trend_pct:       parseFloat(trend.rows[0].trend_pct),
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
      'SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC'
    );
    res.json(rows.map(r => ({
      date:     r.date,
      visitors: parseInt(r.visitors, 10),
      revenue:  parseFloat(r.revenue),
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
      'SELECT name, value FROM categories ORDER BY value DESC'
    );
    res.json(rows.map(r => ({
      name:  r.name,
      value: parseInt(r.value, 10),
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/recent
app.get('/api/recent', async (_req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20'
    );
    res.json(rows.map(r => ({
      name:       r.name,
      category:   r.category,
      value:      parseFloat(r.value),
      created_at: r.created_at,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings
app.get('/api/settings', async (_req, res) => {
  try {
    const { rows } = await db.query("SELECT value FROM settings WHERE key = 'theme'");
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
    if (!['light', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    await db.query(
      "INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [theme]
    );
    res.json({ theme });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Backend listening on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
