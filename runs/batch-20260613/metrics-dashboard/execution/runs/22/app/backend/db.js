const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'pgdata');

// Simple seeded PRNG (mulberry32)
function mulberry32(seed) {
  return function() {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function initDB() {
  const db = new PGlite(DB_PATH);

  // Check if already seeded
  try {
    const check = await db.query("SELECT COUNT(*) AS cnt FROM daily_metrics");
    if (Number(check.rows[0].cnt) > 0) {
      console.log('Database already seeded.');
      return db;
    }
  } catch (e) {
    // Table doesn't exist, proceed with schema creation
  }

  console.log('Creating schema and seeding data...');

  // Create tables
  await db.query(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue NUMERIC(12,2) NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      value INTEGER NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(255) NOT NULL,
      value NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMP NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key VARCHAR(50) PRIMARY KEY,
      value VARCHAR(255) NOT NULL
    );
  `);

  // Deterministic seed
  const rng = mulberry32(42);

  // Helper: random int in [min, max]
  function randInt(min, max) {
    return Math.floor(rng() * (max - min + 1)) + min;
  }

  // Seed daily_metrics: 30 days ending today (use fixed date for determinism)
  const baseDate = new Date('2025-01-15');
  for (let i = 29; i >= 0; i--) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const visitors = randInt(800, 5000);
    const revenue = (randInt(5000, 25000) + rng() * 100).toFixed(2);
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, visitors, revenue]
    );
  }

  // Seed categories: 6 rows, one with a long label, one with value >= 1,000,000
  const categoryData = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1284953 },
    { name: 'Marketing', value: randInt(200000, 500000) },
    { name: 'Sales', value: randInt(300000, 600000) },
    { name: 'Engineering', value: randInt(400000, 800000) },
    { name: 'Support', value: randInt(100000, 300000) },
    { name: 'Operations', value: randInt(150000, 350000) }
  ];

  for (const cat of categoryData) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [cat.name, cat.value]
    );
  }

  // Seed recent_items: 20 rows
  const itemNames = [
    'Server Upgrade', 'License Renewal', 'Cloud Migration', 'Security Audit',
    'Data Backup', 'Network Setup', 'Software Deploy', 'Bug Fix Patch',
    'Performance Review', 'API Integration', 'Database Tune', 'Cache Layer',
    'Load Balancer', 'SSL Certificate', 'DNS Config', 'Firewall Rule',
    'Log Aggregation', 'Container Deploy', 'CI/CD Pipeline', 'Monitoring Alert'
  ];
  const itemCategories = ['Infrastructure', 'Security', 'Development', 'Operations', 'Marketing', 'Support'];

  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = itemCategories[i % itemCategories.length];
    const value = (randInt(100, 50000) + rng() * 100).toFixed(2);
    const createdAt = new Date(baseDate);
    createdAt.setDate(createdAt.getDate() - i);
    createdAt.setHours(randInt(8, 18), randInt(0, 59), randInt(0, 59));
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, createdAt.toISOString()]
    );
  }

  // Seed settings
  await db.query("INSERT INTO settings (key, value) VALUES ('theme', 'light')");

  console.log('Database seeded successfully.');
  return db;
}

module.exports = { initDB };
