import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../data/pglite');

// Ensure data directory exists
mkdirSync(DATA_DIR, { recursive: true });

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve static frontend in production
const CLIENT_DIST = join(__dirname, '../client/dist');
app.use(express.static(CLIENT_DIST));

// Initialize PGLite
let db;

async function initDB() {
  db = new PGlite(`file://${DATA_DIR}`);
  await db.waitReady;
  await setupSchema();
  await seedData();
}

async function setupSchema() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue NUMERIC(12,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      value BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      value NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

// Deterministic pseudo-random number generator (LCG with fixed seed)
function createRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = Math.imul(s, 1664525) + 1013904223;
    s = s >>> 0;
    return s / 0x100000000;
  };
}

async function seedData() {
  // Check if already seeded
  const existing = await db.query('SELECT COUNT(*) as cnt FROM daily_metrics');
  if (parseInt(existing.rows[0].cnt) > 0) {
    console.log('Database already seeded, skipping.');
    return;
  }

  console.log('Seeding database...');
  const rng = createRng(42);

  // Seed 30 days of daily_metrics starting 2024-01-01
  const baseDate = new Date('2024-01-01');
  for (let i = 0; i < 30; i++) {
    const date = new Date(baseDate);
    date.setDate(baseDate.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];
    const visitors = Math.floor(rng() * 4000) + 1000; // 1000–5000
    const revenue = (rng() * 9000 + 1000).toFixed(2);  // 1000–10000
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, visitors, revenue]
    );
  }

  // Seed 6 categories (one long label, one value >= 1,000,000)
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1250000 },
    { name: 'Cloud Services',         value: Math.floor(rng() * 500000) + 200000 },
    { name: 'Professional Services',  value: Math.floor(rng() * 300000) + 100000 },
    { name: 'Support & Maintenance',  value: Math.floor(rng() * 200000) + 50000 },
    { name: 'Training',               value: Math.floor(rng() * 100000) + 20000 },
    { name: 'Licensing',              value: Math.floor(rng() * 150000) + 30000 },
  ];

  for (const cat of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [cat.name, cat.value]
    );
  }

  // Seed 20 recent items
  const itemNames = [
    'Project Alpha', 'Project Beta', 'Project Gamma', 'Project Delta',
    'Project Epsilon', 'Project Zeta', 'Project Eta', 'Project Theta',
    'Project Iota', 'Project Kappa', 'Project Lambda', 'Project Mu',
    'Project Nu', 'Project Xi', 'Project Omicron', 'Project Pi',
    'Project Rho', 'Project Sigma', 'Project Tau', 'Project Upsilon',
  ];
  const catNames = categories.map(c => c.name);

  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = catNames[Math.floor(rng() * catNames.length)];
    const value = (rng() * 50000 + 500).toFixed(2);
    const daysAgo = Math.floor(rng() * 30);
    const createdAt = new Date(baseDate);
    createdAt.setDate(baseDate.getDate() + 29 - daysAgo);
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, createdAt.toISOString()]
    );
  }

  // Seed default settings
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING`
  );

  console.log('Database seeded successfully.');
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// GET /api/summary
app.get('/api/summary', async (req, res) => {
  try {
    const totalVisitors = await db.query(
      'SELECT SUM(visitors) as total FROM daily_metrics'
    );
    const totalRevenue = await db.query(
      'SELECT SUM(revenue) as total FROM daily_metrics'
    );
    const bestDay = await db.query(
      'SELECT date, visitors, revenue FROM daily_metrics ORDER BY revenue DESC LIMIT 1'
    );

    // 7-day trend: compare last 7 days vs previous 7 days (by revenue)
    const last7 = await db.query(
      `SELECT SUM(revenue) as total FROM (
        SELECT revenue FROM daily_metrics ORDER BY date DESC LIMIT 7
      ) t`
    );
    const prev7 = await db.query(
      `SELECT SUM(revenue) as total FROM (
        SELECT revenue FROM daily_metrics ORDER BY date DESC LIMIT 14 OFFSET 7
      ) t`
    );

    const last7Total = parseFloat(last7.rows[0].total) || 0;
    const prev7Total = parseFloat(prev7.rows[0].total) || 0;
    const trendPct = prev7Total === 0
      ? 0
      : ((last7Total - prev7Total) / prev7Total * 100);

    res.json({
      totalVisitors: parseInt(totalVisitors.rows[0].total) || 0,
      totalRevenue: parseFloat(totalRevenue.rows[0].total) || 0,
      bestDay: bestDay.rows[0]
        ? {
            date: bestDay.rows[0].date,
            visitors: parseInt(bestDay.rows[0].visitors),
            revenue: parseFloat(bestDay.rows[0].revenue),
          }
        : null,
      trendPct: parseFloat(trendPct.toFixed(2)),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

// GET /api/timeseries
app.get('/api/timeseries', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC'
    );
    res.json(result.rows.map(r => ({
      date: r.date,
      visitors: parseInt(r.visitors),
      revenue: parseFloat(r.revenue),
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch timeseries' });
  }
});

// GET /api/categories
app.get('/api/categories', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT name, value FROM categories ORDER BY value DESC'
    );
    res.json(result.rows.map(r => ({
      name: r.name,
      value: parseInt(r.value),
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// GET /api/recent
app.get('/api/recent', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20'
    );
    res.json(result.rows.map(r => ({
      name: r.name,
      category: r.category,
      value: parseFloat(r.value),
      createdAt: r.created_at,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch recent items' });
  }
});

// GET /api/settings
app.get('/api/settings', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT value FROM settings WHERE key = 'theme'`
    );
    const theme = result.rows[0]?.value || 'light';
    res.json({ theme });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// PUT /api/settings
app.put('/api/settings', async (req, res) => {
  try {
    const { theme } = req.body;
    if (!['light', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'Invalid theme value' });
    }
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('theme', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [theme]
    );
    res.json({ theme });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Fallback: serve index.html for SPA
app.get('*', (req, res) => {
  const indexPath = join(CLIENT_DIST, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      res.status(404).send('Frontend not built. Run: npm run build');
    }
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Metrics Dashboard server running on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
