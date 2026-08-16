import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = join(__dirname, 'metrics.db');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// Initialize PGLite
let db;
let dbInitialized = false;

async function initDb() {
  if (dbInitialized) return db;
  
  const exists = fs.existsSync(DB_PATH);
  db = new PGlite(DB_PATH);
  await db.waitReady;
  
  if (!exists) {
    await seedDatabase();
  }
  
  dbInitialized = true;
  return db;
}

async function seedDatabase() {
  console.log('Seeding database with deterministic data...');
  
  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL,
      visitors INTEGER NOT NULL,
      revenue DECIMAL(10,2) NOT NULL
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
      value INTEGER NOT NULL,
      created_at TIMESTAMP NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  
  // Seed daily_metrics - 30 days, deterministic
  const seed = 42;
  let rand = seed;
  const random = () => {
    rand = (rand * 16807) % 2147483647;
    return rand / 2147483647;
  };
  
  const baseDate = new Date('2024-12-01');
  for (let i = 0; i < 30; i++) {
    const date = new Date(baseDate);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];
    const visitors = Math.floor(800 + random() * 1200);
    const revenue = Math.floor(5000 + random() * 15000);
    await db.exec(`
      INSERT INTO daily_metrics (date, visitors, revenue) 
      VALUES ('${dateStr}', ${visitors}, ${revenue})
    `);
  }
  
  // Seed categories - 6 rows, one long label, one >=1M
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 2450000 },
    { name: 'SaaS Subscriptions', value: 1890000 },
    { name: 'Professional Services', value: 920000 },
    { name: 'Hardware Sales', value: 675000 },
    { name: 'Training & Education', value: 340000 },
    { name: 'Support Contracts', value: 285000 }
  ];
  
  for (const cat of categories) {
    await db.exec(`
      INSERT INTO categories (name, value) 
      VALUES ('${cat.name}', ${cat.value})
    `);
  }
  
  // Seed recent_items - 20 rows
  const itemNames = [
    'Acme Corp License Renewal', 'TechStart Inc. Upgrade', 'Global Systems Audit',
    'Cloud Migration Project', 'Security Assessment', 'Data Analytics Platform',
    'API Integration', 'Mobile App Development', 'Infrastructure Review',
    'Compliance Certification', 'Performance Optimization', 'Database Migration',
    'Network Upgrade', 'Software License', 'Consulting Hours',
    'Training Workshop', 'Support Package', 'Hardware Procurement',
    'Custom Development', 'Annual Maintenance'
  ];
  
  const itemCategories = ['Enterprise', 'SaaS', 'Services', 'Hardware', 'Training', 'Support'];
  
  for (let i = 0; i < 20; i++) {
    const name = itemNames[i % itemNames.length];
    const cat = itemCategories[i % itemCategories.length];
    const value = Math.floor(15000 + random() * 85000);
    const created = new Date(baseDate);
    created.setDate(created.getDate() + (29 - Math.floor(i / 2)));
    const createdStr = created.toISOString();
    
    await db.exec(`
      INSERT INTO recent_items (name, category, value, created_at) 
      VALUES ('${name}', '${cat}', ${value}, '${createdStr}')
    `);
  }
  
  // Default settings
  await db.exec(`
    INSERT INTO settings (key, value) VALUES ('theme', 'light')
    ON CONFLICT (key) DO NOTHING
  `);
  
  console.log('Database seeded successfully');
}

async function getDb() {
  return await initDb();
}

// API Routes

// GET /api/summary
app.get('/api/summary', async (req, res) => {
  try {
    const db = await getDb();
    
    const visitorsResult = await db.query('SELECT SUM(visitors) as total FROM daily_metrics');
    const totalVisitors = visitorsResult.rows[0].total;
    
    const revenueResult = await db.query('SELECT SUM(revenue) as total FROM daily_metrics');
    const totalRevenue = parseFloat(revenueResult.rows[0].total);
    
    const bestDayResult = await db.query('SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1');
    const bestDay = bestDayResult.rows[0];
    
    // 7-day trend
    const recentResult = await db.query(`
      SELECT SUM(visitors) as total FROM daily_metrics 
      WHERE date >= (SELECT MAX(date) - INTERVAL '6 days' FROM daily_metrics)
    `);
    const prevResult = await db.query(`
      SELECT SUM(visitors) as total FROM daily_metrics 
      WHERE date >= (SELECT MAX(date) - INTERVAL '13 days' FROM daily_metrics)
      AND date < (SELECT MAX(date) - INTERVAL '6 days' FROM daily_metrics)
    `);
    
    const recentTotal = recentResult.rows[0].total || 0;
    const prevTotal = prevResult.rows[0].total || 1;
    const trend = ((recentTotal - prevTotal) / prevTotal * 100).toFixed(1);
    
    res.json({
      totalVisitors,
      totalRevenue,
      bestDay: {
        date: bestDay.date,
        visitors: bestDay.visitors
      },
      sevenDayTrend: parseFloat(trend)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

// GET /api/timeseries
app.get('/api/timeseries', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query('SELECT date, visitors, revenue FROM daily_metrics ORDER BY date');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch timeseries' });
  }
});

// GET /api/categories
app.get('/api/categories', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query('SELECT name, value FROM categories ORDER BY value DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// GET /api/recent
app.get('/api/recent', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch recent items' });
  }
});

// GET /api/settings
app.get('/api/settings', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query("SELECT value FROM settings WHERE key = 'theme'");
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
    const db = await getDb();
    const { theme } = req.body;
    if (!['light', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'Invalid theme' });
    }
    await db.exec(`
      INSERT INTO settings (key, value) VALUES ('theme', '${theme}')
      ON CONFLICT (key) DO UPDATE SET value = '${theme}'
    `);
    res.json({ theme });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  initDb().catch(console.error);
});