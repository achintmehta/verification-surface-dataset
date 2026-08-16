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

// ---------------------------------------------------------------------------
// Database initialisation
// ---------------------------------------------------------------------------
const db = new PGlite(DB_DIR);

async function initDb() {
  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id        SERIAL PRIMARY KEY,
      date      DATE        NOT NULL UNIQUE,
      visitors  INTEGER     NOT NULL,
      revenue   NUMERIC(12,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id    SERIAL PRIMARY KEY,
      name  TEXT    NOT NULL UNIQUE,
      value BIGINT  NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_items (
      id         SERIAL PRIMARY KEY,
      name       TEXT           NOT NULL,
      category   TEXT           NOT NULL,
      value      NUMERIC(12,2)  NOT NULL,
      created_at TIMESTAMPTZ    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Check if already seeded
  const { rows } = await db.query('SELECT COUNT(*) AS cnt FROM daily_metrics');
  if (parseInt(rows[0].cnt, 10) > 0) {
    console.log('Database already seeded — skipping.');
    return;
  }

  console.log('Seeding database…');

  // ------------------------------------------------------------------
  // Deterministic pseudo-random number generator (mulberry32)
  // ------------------------------------------------------------------
  function mulberry32(seed) {
    let s = seed >>> 0;
    return function () {
      s += 0x6d2b79f5;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = mulberry32(0xdeadbeef);

  // ------------------------------------------------------------------
  // Seed daily_metrics — 30 days ending yesterday
  // ------------------------------------------------------------------
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dailyRows = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const visitors = Math.floor(rand() * 4500) + 500;          // 500–5000
    const revenue  = (rand() * 9000 + 1000).toFixed(2);        // 1000–10000
    dailyRows.push({ date: dateStr, visitors, revenue });
  }

  for (const row of dailyRows) {
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [row.date, row.visitors, row.revenue]
    );
  }

  // ------------------------------------------------------------------
  // Seed categories — 6 rows, one long label, one value ≥ 1,000,000
  // ------------------------------------------------------------------
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1_284_750 },
    { name: 'Cloud Services',                         value: Math.floor(rand() * 400_000) + 200_000 },
    { name: 'Professional Services',                  value: Math.floor(rand() * 300_000) + 100_000 },
    { name: 'Support & Maintenance',                  value: Math.floor(rand() * 200_000) +  50_000 },
    { name: 'Training & Certification',               value: Math.floor(rand() *  80_000) +  20_000 },
    { name: 'Consulting',                             value: Math.floor(rand() *  60_000) +  10_000 },
  ];

  for (const cat of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [cat.name, cat.value]
    );
  }

  // ------------------------------------------------------------------
  // Seed recent_items — 20 rows
  // ------------------------------------------------------------------
  const catNames = categories.map(c => c.name);
  const itemNames = [
    'Acme Corp Renewal', 'Beta Systems Upgrade', 'Gamma Analytics Suite',
    'Delta Cloud Migration', 'Epsilon Security Audit', 'Zeta Compliance Review',
    'Eta Data Pipeline', 'Theta API Integration', 'Iota Mobile Platform',
    'Kappa Reporting Tool', 'Lambda Workflow Engine', 'Mu DevOps Bundle',
    'Nu Storage Expansion', 'Xi Network Overhaul', 'Omicron AI Module',
    'Pi Dashboard Pro', 'Rho Backup Solution', 'Sigma Identity Suite',
    'Tau Monitoring Stack', 'Upsilon Edge Deployment',
  ];

  for (let i = 0; i < 20; i++) {
    const name     = itemNames[i];
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value    = (rand() * 49_000 + 1_000).toFixed(2);
    const daysAgo  = Math.floor(rand() * 30);
    const createdAt = new Date(today);
    createdAt.setDate(createdAt.getDate() - daysAgo);
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, createdAt.toISOString()]
    );
  }

  // ------------------------------------------------------------------
  // Default settings
  // ------------------------------------------------------------------
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('theme', 'light')
     ON CONFLICT (key) DO NOTHING`
  );

  console.log('Seeding complete.');
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

/** GET /api/summary */
app.get('/api/summary', async (_req, res) => {
  try {
    // Total visitors & revenue
    const totals = await db.query(`
      SELECT
        SUM(visitors)::BIGINT  AS total_visitors,
        SUM(revenue)::NUMERIC  AS total_revenue
      FROM daily_metrics
    `);

    // Best day (highest visitors)
    const best = await db.query(`
      SELECT date, visitors
      FROM daily_metrics
      ORDER BY visitors DESC
      LIMIT 1
    `);

    // 7-day trend: compare last 7 days vs previous 7 days (by visitors)
    const trend = await db.query(`
      WITH ordered AS (
        SELECT visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM daily_metrics
      ),
      last7   AS (SELECT AVG(visitors) AS avg FROM ordered WHERE rn <= 7),
      prev7   AS (SELECT AVG(visitors) AS avg FROM ordered WHERE rn > 7 AND rn <= 14)
      SELECT
        CASE
          WHEN prev7.avg = 0 OR prev7.avg IS NULL THEN 0
          ELSE ROUND(((last7.avg - prev7.avg) / prev7.avg * 100)::NUMERIC, 1)
        END AS trend_pct
      FROM last7, prev7
    `);

    res.json({
      total_visitors: parseInt(totals.rows[0].total_visitors, 10),
      total_revenue:  parseFloat(totals.rows[0].total_revenue),
      best_day: {
        date:     best.rows[0].date,
        visitors: parseInt(best.rows[0].visitors, 10),
      },
      trend_pct: parseFloat(trend.rows[0].trend_pct),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/timeseries */
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

/** GET /api/categories */
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

/** GET /api/recent */
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

/** GET /api/settings */
app.get('/api/settings', async (_req, res) => {
  try {
    const { rows } = await db.query(`SELECT key, value FROM settings`);
    const settings = {};
    for (const row of rows) settings[row.key] = row.value;
    res.json(settings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/** PUT /api/settings */
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

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3001;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Backend listening on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialise database:', err);
    process.exit(1);
  });
