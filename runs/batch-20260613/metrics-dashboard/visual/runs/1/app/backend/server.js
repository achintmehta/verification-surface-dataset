import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, 'data');
mkdirSync(DATA_DIR, { recursive: true });

// ─── Database ────────────────────────────────────────────────────────────────

const db = new PGlite(join(DATA_DIR, 'metrics.db'));

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id        SERIAL PRIMARY KEY,
      date      DATE        NOT NULL UNIQUE,
      visitors  INTEGER     NOT NULL,
      revenue   NUMERIC(12,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id    SERIAL PRIMARY KEY,
      name  TEXT          NOT NULL UNIQUE,
      value NUMERIC(14,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_items (
      id         SERIAL PRIMARY KEY,
      name       TEXT          NOT NULL,
      category   TEXT          NOT NULL,
      value      NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ   NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Check if already seeded
  const { rows } = await db.query('SELECT COUNT(*) AS cnt FROM daily_metrics');
  if (parseInt(rows[0].cnt, 10) > 0) {
    console.log('Database already seeded, skipping.');
    return;
  }

  console.log('Seeding database...');
  await seed();
  console.log('Seeding complete.');
}

// ─── Deterministic pseudo-random (LCG) ───────────────────────────────────────

function makePrng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

async function seed() {
  const rng = makePrng(42);

  // 30 days of daily_metrics ending yesterday
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const rows = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const visitors = Math.floor(rng() * 4500) + 500;   // 500–5000
    const revenue  = parseFloat((rng() * 9000 + 1000).toFixed(2)); // 1000–10000
    rows.push(`('${dateStr}', ${visitors}, ${revenue})`);
  }
  await db.exec(
    `INSERT INTO daily_metrics (date, visitors, revenue) VALUES ${rows.join(',')};`
  );

  // 6 categories (one long name, one value ≥ 1,000,000)
  const categories = [
    ['Direct Sales',                          parseFloat((rng() * 50000 + 20000).toFixed(2))],
    ['Online Marketplace',                    parseFloat((rng() * 80000 + 30000).toFixed(2))],
    ['Enterprise Infrastructure & Compliance', 1_234_567.89],
    ['Partner Referrals',                     parseFloat((rng() * 40000 + 10000).toFixed(2))],
    ['Organic Search',                        parseFloat((rng() * 60000 + 15000).toFixed(2))],
    ['Social Media',                          parseFloat((rng() * 30000 + 5000).toFixed(2))],
  ];
  const catRows = categories.map(([n, v]) => `('${n}', ${v})`).join(',');
  await db.exec(`INSERT INTO categories (name, value) VALUES ${catRows};`);

  // 20 recent items
  const catNames = categories.map(([n]) => n);
  const itemRows = [];
  for (let i = 0; i < 20; i++) {
    const name     = `Item ${String.fromCharCode(65 + i)} — ${adjectives[i % adjectives.length]} ${nouns[i % nouns.length]}`;
    const category = catNames[Math.floor(rng() * catNames.length)];
    const value    = parseFloat((rng() * 5000 + 100).toFixed(2));
    const hoursAgo = Math.floor(rng() * 72);
    const createdAt = new Date(today.getTime() - hoursAgo * 3_600_000).toISOString();
    itemRows.push(`('${escapeSql(name)}', '${escapeSql(category)}', ${value}, '${createdAt}')`);
  }
  await db.exec(
    `INSERT INTO recent_items (name, category, value, created_at) VALUES ${itemRows.join(',')};`
  );

  // Default settings
  await db.exec(`INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT DO NOTHING;`);
}

const adjectives = ['Premium','Advanced','Core','Elite','Smart','Pro','Rapid','Secure','Global','Unified'];
const nouns      = ['Widget','Module','Package','Bundle','Suite','Platform','Service','Solution','Tool','Engine'];

function escapeSql(s) {
  return s.replace(/'/g, "''");
}

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// GET /api/summary
app.get('/api/summary', async (_req, res) => {
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
      last7  AS (SELECT SUM(revenue) AS s FROM ordered WHERE rn <= 7),
      prior7 AS (SELECT SUM(revenue) AS s FROM ordered WHERE rn BETWEEN 8 AND 14)
      SELECT
        last7.s  AS last_revenue,
        prior7.s AS prior_revenue
      FROM last7, prior7
    `);

    const last  = parseFloat(trend.rows[0].last_revenue  || 0);
    const prior = parseFloat(trend.rows[0].prior_revenue || 0);
    const trendPct = prior === 0 ? 0 : parseFloat(((last - prior) / prior * 100).toFixed(1));

    res.json({
      total_visitors: parseInt(totals.rows[0].total_visitors, 10),
      total_revenue:  parseFloat(totals.rows[0].total_revenue),
      best_day: {
        date:     bestDay.rows[0].date,
        visitors: bestDay.rows[0].visitors,
        revenue:  parseFloat(bestDay.rows[0].revenue),
      },
      trend_7d_pct: trendPct,
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
      SELECT date, visitors, revenue::float AS revenue
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
      SELECT name, value::float AS value
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
      SELECT id, name, category, value::float AS value, created_at
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
    await db.exec(`
      INSERT INTO settings (key, value) VALUES ('theme', '${theme}')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
    `);
    res.json({ theme });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Backend listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialise database:', err);
    process.exit(1);
  });
