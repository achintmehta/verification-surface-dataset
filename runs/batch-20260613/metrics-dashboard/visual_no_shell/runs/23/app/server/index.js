import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'pgdata');

const app = express();
app.use(cors());
app.use(express.json());

let db;

async function initDB() {
  db = new PGlite(DB_PATH);

  // Check if already seeded
  const tableCheck = await db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables WHERE table_name = 'daily_metrics'
    ) AS exists
  `);

  if (tableCheck.rows[0].exists) {
    console.log('Database already seeded.');
    return;
  }

  console.log('Creating schema and seeding data...');

  // Create tables
  await db.query(`
    CREATE TABLE daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL,
      visitors INTEGER NOT NULL,
      revenue NUMERIC(12,2) NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      value INTEGER NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE recent_items (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(255) NOT NULL,
      value NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMP NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE settings (
      key VARCHAR(50) PRIMARY KEY,
      value VARCHAR(255) NOT NULL
    );
  `);

  // Seed settings
  await db.query(`INSERT INTO settings (key, value) VALUES ('theme', 'light')`);

  // Deterministic seed for daily_metrics: 30 days
  // Using a simple seeded pseudo-random number generator
  const baseDate = new Date('2025-01-01');
  const seedVisitors = [
    1245, 1389, 1567, 1423, 1678, 1890, 2034,
    1876, 1654, 1432, 1298, 1567, 1789, 1934,
    2156, 2345, 2123, 1987, 1765, 1543, 1678,
    1890, 2012, 2234, 2456, 2678, 2890, 3012,
    2876, 2654
  ];
  const seedRevenue = [
    3245.50, 3589.75, 4123.00, 3876.25, 4567.50, 5123.75, 5678.00,
    5234.50, 4567.25, 3890.00, 3456.75, 4123.50, 4890.25, 5234.00,
    5890.75, 6345.50, 5780.25, 5345.00, 4890.75, 4234.50, 4678.25,
    5123.00, 5567.75, 6012.50, 6678.25, 7234.00, 7890.75, 8123.50,
    7678.25, 7123.00
  ];

  for (let i = 0; i < 30; i++) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    await db.query(
      `INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)`,
      [dateStr, seedVisitors[i], seedRevenue[i]]
    );
  }

  // Seed categories (6 rows, one long label, one value >= 1,000,000)
  const categories = [
    { name: 'Electronics', value: 1245678 },
    { name: 'Clothing', value: 534290 },
    { name: 'Enterprise Infrastructure & Compliance', value: 892345 },
    { name: 'Food & Beverage', value: 345678 },
    { name: 'Health & Wellness', value: 678901 },
    { name: 'Home & Garden', value: 456789 }
  ];

  for (const cat of categories) {
    await db.query(
      `INSERT INTO categories (name, value) VALUES ($1, $2)`,
      [cat.name, cat.value]
    );
  }

  // Seed recent_items (20 rows)
  const itemNames = [
    'Widget Pro', 'Gadget X', 'Smart Sensor', 'Power Module', 'Data Hub',
    'Cloud Connector', 'Edge Device', 'API Gateway', 'Load Balancer', 'Cache Server',
    'Stream Processor', 'Queue Manager', 'Auth Token', 'Config Agent', 'Log Analyzer',
    'Metric Tracker', 'Alert Monitor', 'Dashboard Kit', 'Report Builder', 'Export Tool'
  ];
  const itemCategories = [
    'Electronics', 'Electronics', 'Electronics', 'Electronics', 'Clothing',
    'Clothing', 'Enterprise Infrastructure & Compliance', 'Enterprise Infrastructure & Compliance', 'Food & Beverage', 'Food & Beverage',
    'Health & Wellness', 'Health & Wellness', 'Home & Garden', 'Home & Garden', 'Electronics',
    'Clothing', 'Enterprise Infrastructure & Compliance', 'Food & Beverage', 'Health & Wellness', 'Home & Garden'
  ];
  const itemValues = [
    299.99, 149.50, 89.99, 199.00, 59.99,
    79.50, 349.99, 449.00, 24.99, 34.50,
    129.99, 89.00, 45.99, 67.50, 199.99,
    39.99, 599.00, 19.99, 149.50, 79.99
  ];

  for (let i = 0; i < 20; i++) {
    const createdAt = new Date('2025-01-25');
    createdAt.setHours(createdAt.getHours() - i * 3);
    await db.query(
      `INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)`,
      [itemNames[i], itemCategories[i], itemValues[i], createdAt.toISOString()]
    );
  }

  console.log('Database seeded successfully.');
}

// API Routes

// GET /api/summary - four headline numbers
app.get('/api/summary', async (req, res) => {
  try {
    const totalVisitors = await db.query(`SELECT SUM(visitors) as total FROM daily_metrics`);
    const totalRevenue = await db.query(`SELECT SUM(revenue) as total FROM daily_metrics`);
    const bestDay = await db.query(`SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1`);

    // 7-day trend: compare last 7 days avg to previous 7 days avg
    const last7 = await db.query(`
      SELECT AVG(visitors) as avg_visitors FROM (
        SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 7
      ) sub
    `);
    const prev7 = await db.query(`
      SELECT AVG(visitors) as avg_visitors FROM (
        SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 7 OFFSET 7
      ) sub
    `);

    const last7Avg = parseFloat(last7.rows[0].avg_visitors);
    const prev7Avg = parseFloat(prev7.rows[0].avg_visitors);
    const trend = prev7Avg > 0 ? (((last7Avg - prev7Avg) / prev7Avg) * 100) : 0;

    res.json({
      totalVisitors: parseInt(totalVisitors.rows[0].total),
      totalRevenue: parseFloat(totalRevenue.rows[0].total),
      bestDay: {
        date: bestDay.rows[0].date,
        visitors: parseInt(bestDay.rows[0].visitors)
      },
      weeklyTrend: Math.round(trend * 10) / 10
    });
  } catch (err) {
    console.error('Error in /api/summary:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/timeseries
app.get('/api/timeseries', async (req, res) => {
  try {
    const result = await db.query(`SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC`);
    res.json(result.rows);
  } catch (err) {
    console.error('Error in /api/timeseries:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/categories
app.get('/api/categories', async (req, res) => {
  try {
    const result = await db.query(`SELECT name, value FROM categories ORDER BY value DESC`);
    res.json(result.rows);
  } catch (err) {
    console.error('Error in /api/categories:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/recent
app.get('/api/recent', async (req, res) => {
  try {
    const result = await db.query(`SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (err) {
    console.error('Error in /api/recent:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/settings
app.get('/api/settings', async (req, res) => {
  try {
    const result = await db.query(`SELECT value FROM settings WHERE key = 'theme'`);
    const theme = result.rows.length > 0 ? result.rows[0].value : 'light';
    res.json({ theme });
  } catch (err) {
    console.error('Error in GET /api/settings:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/settings
app.put('/api/settings', async (req, res) => {
  try {
    const { theme } = req.body;
    if (!theme || !['light', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'Invalid theme. Must be "light" or "dark".' });
    }
    await db.query(`UPDATE settings SET value = $1 WHERE key = 'theme'`, [theme]);
    res.json({ theme });
  } catch (err) {
    console.error('Error in PUT /api/settings:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3001;

initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend server running on http://0.0.0.0:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
