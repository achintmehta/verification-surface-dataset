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
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ─── Database initialization ────────────────────────────────────────────────

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

// ─── Deterministic pseudo-random (seeded LCG) ───────────────────────────────

function makePRNG(seed) {
  let s = seed >>> 0;
  return function () {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

async function seedDatabase() {
  const rand = makePRNG(42);

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
    dailyRows.push({ date: dateStr, visitors, revenue });
  }

  for (const row of dailyRows) {
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [row.date, row.visitors, row.revenue]
    );
  }

  // ── categories: 6 rows, one long label, one value ≥ 1,000,000 ────────────
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1_284_750 },
    { name: 'Cloud Services',                         value: Math.floor(rand() * 500_000) + 200_000 },
    { name: 'Professional Services',                  value: Math.floor(rand() * 300_000) + 100_000 },
    { name: 'Support & Maintenance',                  value: Math.floor(rand() * 200_000) + 50_000  },
    { name: 'Training & Certification',               value: Math.floor(rand() * 150_000) + 30_000  },
    { name: 'Consulting',                             value: Math.floor(rand() * 100_000) + 20_000  },
  ];

  for (const cat of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [cat.name, cat.value]
    );
  }

  // ── recent_items: 20 rows ─────────────────────────────────────────────────
  const catNames = categories.map(c => c.name);
  const itemNames = [
    'Project Alpha', 'Project Beta', 'Project Gamma', 'Project Delta',
    'Project Epsilon', 'Project Zeta', 'Project Eta', 'Project Theta',
    'Project Iota', 'Project Kappa', 'Project Lambda', 'Project Mu',
    'Project Nu', 'Project Xi', 'Project Omicron', 'Project Pi',
    'Project Rho', 'Project Sigma', 'Project Tau', 'Project Upsilon',
  ];

  for (let i = 0; i < 20; i++) {
    const name     = itemNames[i];
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value    = (rand() * 50_000 + 500).toFixed(2);
    const daysAgo  = Math.floor(rand() * 30);
    const createdAt = new Date(today);
    createdAt.setDate(createdAt.getDate() - daysAgo);

    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, createdAt.toISOString()]
    );
  }

  // ── settings: default theme ───────────────────────────────────────────────
  await db.query(
    "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT DO NOTHING"
  );

  console.log('Database seeded successfully.');
}

// ─── API Routes ──────────────────────────────────────────────────────────────

// GET /api/summary
app.get('/api/summary', async (req, res) => {
  try {
    const totals = await db.query(`
      SELECT
        SUM(visitors)::bigint  AS total_visitors,
        SUM(revenue)::numeric  AS total_revenue
      FROM daily_metrics
    `);

    const bestDay = await db.query(`
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
      last7   AS (SELECT SUM(revenue) AS s FROM ordered WHERE rn <= 7),
      prior7  AS (SELECT SUM(revenue) AS s FROM ordered WHERE rn > 7 AND rn <= 14)
      SELECT
        last7.s  AS last_7,
        prior7.s AS prior_7
      FROM last7, prior7
    `);

    const last7  = parseFloat(trend.rows[0].last_7  || 0);
    const prior7 = parseFloat(trend.rows[0].prior_7 || 0);
    const trendPct = prior7 === 0 ? 0 : ((last7 - prior7) / prior7) * 100;

    res.json({
      total_visitors: parseInt(totals.rows[0].total_visitors, 10),
      total_revenue:  parseFloat(totals.rows[0].total_revenue),
      best_day: {
        date:     bestDay.rows[0].date,
        visitors: bestDay.rows[0].visitors,
        revenue:  parseFloat(bestDay.rows[0].revenue),
      },
      trend_7day_pct: parseFloat(trendPct.toFixed(2)),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/timeseries
app.get('/api/timeseries', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT date, visitors, revenue::float AS revenue
      FROM daily_metrics
      ORDER BY date ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/categories
app.get('/api/categories', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT name, value
      FROM categories
      ORDER BY value DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/recent
app.get('/api/recent', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT name, category, value::float AS value, created_at
      FROM recent_items
      ORDER BY created_at DESC
      LIMIT 20
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/settings
app.get('/api/settings', async (req, res) => {
  try {
    const { rows } = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    const theme = rows.length > 0 ? rows[0].value : 'light';
    res.json({ theme });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
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
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Backend listening on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
