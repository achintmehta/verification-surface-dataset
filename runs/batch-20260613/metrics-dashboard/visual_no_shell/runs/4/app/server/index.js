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
      id         SERIAL PRIMARY KEY,
      date       DATE NOT NULL UNIQUE,
      visitors   INTEGER NOT NULL,
      revenue    NUMERIC(12,2) NOT NULL
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
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
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
    const visitors = Math.floor(rand() * 4500) + 500;          // 500–5000
    const revenue  = (rand() * 9000 + 1000).toFixed(2);        // 1000–10000
    dailyRows.push({ date: dateStr, visitors, revenue });
  }

  for (const r of dailyRows) {
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [r.date, r.visitors, r.revenue]
    );
  }

  // ── categories: 6 rows, one long label, one value ≥ 1,000,000 ────────────
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1_284_750 },
    { name: 'Cloud Services',                         value: Math.floor(rand() * 500_000) + 200_000 },
    { name: 'Professional Services',                  value: Math.floor(rand() * 300_000) + 100_000 },
    { name: 'Support & Maintenance',                  value: Math.floor(rand() * 200_000) + 50_000  },
    { name: 'Training & Certification',               value: Math.floor(rand() * 100_000) + 20_000  },
    { name: 'Consulting',                             value: Math.floor(rand() * 80_000)  + 10_000  },
  ];

  for (const c of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [c.name, c.value]
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
    const hoursAgo = Math.floor(rand() * 720); // up to 30 days ago
    const createdAt = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, createdAt]
    );
  }

  // ── settings: default theme ───────────────────────────────────────────────
  await db.query(
    "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT DO NOTHING"
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
      last7   AS (SELECT SUM(revenue) AS s FROM ordered WHERE rn <= 7),
      prior7  AS (SELECT SUM(revenue) AS s FROM ordered WHERE rn BETWEEN 8 AND 14)
      SELECT
        last7.s  AS last_revenue,
        prior7.s AS prior_revenue
      FROM last7, prior7
    `);

    const lastRev  = parseFloat(trend.rows[0].last_revenue  || 0);
    const priorRev = parseFloat(trend.rows[0].prior_revenue || 0);
    const trendPct = priorRev === 0 ? 0 : ((lastRev - priorRev) / priorRev) * 100;

    res.json({
      total_visitors: parseInt(totals.rows[0].total_visitors, 10),
      total_revenue:  parseFloat(totals.rows[0].total_revenue),
      best_day: {
        date:     best.rows[0].date,
        visitors: best.rows[0].visitors,
        revenue:  parseFloat(best.rows[0].revenue),
      },
      trend_pct: parseFloat(trendPct.toFixed(1)),
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
      SELECT id, name, category, value::FLOAT AS value, created_at
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
