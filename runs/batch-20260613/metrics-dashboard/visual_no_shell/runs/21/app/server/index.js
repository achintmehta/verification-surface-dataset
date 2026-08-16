import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'pgdata');

const app = express();
app.use(cors());
app.use(express.json());

let db;

// Deterministic seeded random number generator (mulberry32)
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function initDb() {
  db = new PGlite(DB_PATH);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue NUMERIC(12,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      value INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      value NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const check = await db.query('SELECT COUNT(*)::int as cnt FROM daily_metrics');
  const count = parseInt(check.rows[0].cnt, 10);

  if (count === 0) {
    await seed();
  }
}

async function seed() {
  const rng = mulberry32(42);

  // Seed 30 days of daily_metrics
  const baseDate = new Date('2025-01-01');
  const inserts = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    const visitors = Math.floor(rng() * 5000) + 500;
    const revenue = Math.floor(rng() * 100000) / 100 + 100;
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, visitors, revenue.toFixed(2)]
    );
  }

  // Seed 6 categories (one long label, one value >= 1,000,000)
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1250000 },
    { name: 'Marketing', value: 345000 },
    { name: 'Sales', value: 780000 },
    { name: 'Engineering', value: 590000 },
    { name: 'Support', value: 210000 },
    { name: 'Analytics', value: 430000 },
  ];
  for (const cat of categories) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [
      cat.name,
      cat.value,
    ]);
  }

  // Seed 20 recent items
  const itemCategories = ['Marketing', 'Sales', 'Engineering', 'Support', 'Analytics', 'Enterprise Infrastructure & Compliance'];
  const itemNames = [
    'Dashboard Redesign', 'API Integration', 'User Onboarding', 'Payment Gateway',
    'Email Campaign', 'Data Pipeline', 'Mobile App', 'Security Audit',
    'Performance Tuning', 'Customer Portal', 'Reporting Module', 'CI/CD Setup',
    'Load Testing', 'Documentation', 'A/B Testing', 'Search Feature',
    'Notifications', 'Analytics SDK', 'Billing System', 'Admin Panel'
  ];
  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = itemCategories[Math.floor(rng() * itemCategories.length)];
    const value = Math.floor(rng() * 50000) / 100 + 50;
    const createdAt = new Date('2025-01-15');
    createdAt.setDate(createdAt.getDate() - Math.floor(rng() * 30));
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value.toFixed(2), createdAt.toISOString()]
    );
  }

  // Default settings
  await db.query("INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING");

  console.log('Database seeded successfully.');
}

// Helper to safely parse numeric values from PGLite
function toNumber(val) {
  if (val == null) return 0;
  const n = Number(val);
  return isNaN(n) ? 0 : n;
}

// --- API Routes ---

// GET /api/summary
app.get('/api/summary', async (req, res) => {
  try {
    const totalVisitorsRes = await db.query('SELECT COALESCE(SUM(visitors), 0) as total FROM daily_metrics');
    const totalRevenueRes = await db.query('SELECT COALESCE(SUM(revenue), 0) as total FROM daily_metrics');
    const bestDayRes = await db.query('SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1');

    // 7-day trend: compare last 7 days vs previous 7 days by date order
    const allRows = await db.query('SELECT visitors FROM daily_metrics ORDER BY date DESC');
    const rows = allRows.rows;
    let last7Sum = 0;
    let prev7Sum = 0;
    for (let i = 0; i < Math.min(7, rows.length); i++) {
      last7Sum += toNumber(rows[i].visitors);
    }
    for (let i = 7; i < Math.min(14, rows.length); i++) {
      prev7Sum += toNumber(rows[i].visitors);
    }
    const trend = prev7Sum === 0 ? 0 : (((last7Sum - prev7Sum) / prev7Sum) * 100);

    const totalVisitors = toNumber(totalVisitorsRes.rows[0].total);
    const totalRevenue = toNumber(totalRevenueRes.rows[0].total);

    // Format date from bestDay - PGLite may return it as a Date object or string
    let bestDate = '';
    if (bestDayRes.rows.length > 0) {
      const rawDate = bestDayRes.rows[0].date;
      if (rawDate instanceof Date) {
        bestDate = rawDate.toISOString().split('T')[0];
      } else if (typeof rawDate === 'string') {
        bestDate = rawDate.split('T')[0];
      } else {
        bestDate = String(rawDate);
      }
    }

    res.json({
      totalVisitors: Math.round(totalVisitors),
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      bestDay: {
        date: bestDate,
        visitors: bestDayRes.rows.length > 0 ? toNumber(bestDayRes.rows[0].visitors) : 0,
      },
      trend7d: Math.round(trend * 100) / 100,
    });
  } catch (err) {
    console.error('Summary error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/timeseries
app.get('/api/timeseries', async (req, res) => {
  try {
    const result = await db.query('SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC');
    // Normalize dates
    const rows = result.rows.map(r => ({
      date: r.date instanceof Date ? r.date.toISOString().split('T')[0] : String(r.date).split('T')[0],
      visitors: toNumber(r.visitors),
      revenue: toNumber(r.revenue),
    }));
    res.json(rows);
  } catch (err) {
    console.error('Timeseries error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/categories
app.get('/api/categories', async (req, res) => {
  try {
    const result = await db.query('SELECT name, value FROM categories ORDER BY value DESC');
    const rows = result.rows.map(r => ({
      name: r.name,
      value: toNumber(r.value),
    }));
    res.json(rows);
  } catch (err) {
    console.error('Categories error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/recent
app.get('/api/recent', async (req, res) => {
  try {
    const result = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC');
    const rows = result.rows.map(r => ({
      name: r.name,
      category: r.category,
      value: toNumber(r.value),
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }));
    res.json(rows);
  } catch (err) {
    console.error('Recent error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/settings
app.get('/api/settings', async (req, res) => {
  try {
    const result = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    const theme = result.rows.length > 0 ? result.rows[0].value : 'light';
    res.json({ theme });
  } catch (err) {
    console.error('Settings GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/settings
app.put('/api/settings', async (req, res) => {
  try {
    const { theme } = req.body;
    if (!theme || !['light', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    await db.query(
      "INSERT INTO settings (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [theme]
    );
    res.json({ theme });
  } catch (err) {
    console.error('Settings PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3001;

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
